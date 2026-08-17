/**
 * Owns token-authenticated AI Service Channel serving routes.
 * Mounted before Tower user auth; every request must carry a signed Channel credential.
 */
import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { createAIServiceChannelConversation, runAIServiceChannelTurn } from '../services/ai-service/ai-service-channel-runtime.js';
import { ChannelCredentialError, credentialFromAuthHeader, verifyChannelCredential } from '../services/ai-service/channel-credential.js';
import { assertChannelCredentialNotRevoked } from '../services/ai-service/channel-credential-revocation.js';
import { assertChannelServingAccess, assertPublicSiteAccess } from '../services/ai-service/channel-access.js';
import { assertChannelQuota } from '../services/ai-service/channel-quota.js';
import { recordChannelUsageEvent } from '../services/ai-service/channel-usage.js';
import { resolvePublicVisitorIdentity } from '../services/ai-service/public-visitor-identity.js';
import { issueConversationResumeGrant, resumeConversation } from '../services/ai-service/conversation-resume.js';
import { publicRequestActions, recordPublicCustomerRequest } from '../services/ai-service/customer-request-actions.js';
import { deleteConversationFile, listConversationFiles, saveConversationFile } from '../services/ai-service/conversation-files.js';
import { queryOne } from '../db/pg-repo.js';

const router = Router();
const conversationUploadStaging = path.join(config.dataDir, 'upload-staging', 'ai-service-conversation-files');
const conversationUpload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) { fs.mkdir(conversationUploadStaging, { recursive: true }).then(() => cb(null, conversationUploadStaging)).catch((err) => cb(err, conversationUploadStaging)); },
    filename(_req, _file, cb) { cb(null, crypto.randomUUID()); },
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

const channelServingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many AI Service Channel requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const ip = req.ip || req.connection.remoteAddress || '0.0.0.0';
    return `ai-service-channel:ip:${ipKeyGenerator(ip)}`;
  },
});

function credential(req: any): string {
  return credentialFromAuthHeader(req.headers?.authorization);
}

function fail(res: any, err: unknown) {
  const message = err instanceof Error ? err.message : 'AI Service Channel request failed';
  const status = err instanceof ChannelCredentialError ? err.status : /not found|inaccessible/i.test(message) ? 404 : /required|invalid|expired|mismatch/i.test(message) ? 401 : 500;
  if (status === 500) console.error('[ai-service-public]', err);
  res.status(status).json({ error: message });
}

function text(value: unknown, name: string): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw new ChannelCredentialError(`${name} required`, 400);
  return s;
}

function applyExposureHeaders(res: any, exposure: string): void {
  res.setHeader('Cache-Control', 'no-store');
  if (exposure !== 'public') res.setHeader('X-Robots-Tag', 'noindex');
}

function writeNdjson(res: any, event: Record<string, unknown>): void {
  if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
}

async function activeSiteChannel(channelId: string, password?: string): Promise<{ serviceId: string; channelId: string; exposure: 'unlisted' | 'public' }> {
  const row = await queryOne<{ service_id: string; config: Record<string, unknown> | null }>(
    `SELECT c.service_id, c.config
       FROM ai_service_channels c
       JOIN ai_services s ON s.id=c.service_id AND s.status='active' AND s.current_deployment_id=c.active_deployment_id
       JOIN ai_service_deployments d ON d.id=c.active_deployment_id AND d.service_id=c.service_id AND d.status='active'
      WHERE c.id=$1 AND c.status='enabled' AND c.active_deployment_id IS NOT NULL`,
    [channelId],
  );
  if (!row) throw new ChannelCredentialError('AI Service website is not deployed', 404);
  const access = assertPublicSiteAccess({ config: row.config, password });
  return { serviceId: row.service_id, channelId, exposure: access.mode === 'public' ? 'public' : 'unlisted' };
}

function publicString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/secret|token|password|credential|private[_-]?key/i.test(trimmed)) return undefined;
  return trimmed.slice(0, 240);
}

function publicFace(value: unknown): string | undefined {
  const face = publicString(value);
  if (!face) return undefined;
  if (face.startsWith('character:') || face.startsWith('generated:')) return face;
  return face.length <= 8 ? face : undefined;
}

function publicPath(value: unknown): string | undefined {
  const path = publicString(value);
  if (!path) return undefined;
  if (path.startsWith('/') || path.startsWith('~') || path.includes('..') || path.includes('workspace/')) return undefined;
  return path;
}

function publicMaterials(source: Record<string, unknown>): Array<Record<string, string>> {
  if (!Array.isArray(source.refs)) return [];
  return source.refs.slice(0, 20).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const material: Record<string, string> = {};
    const id = publicString(row.id ?? row.ref);
    const type = publicString(row.type ?? row.kind);
    const title = publicString(row.title ?? row.name ?? row.label);
    const url = publicString(row.url);
    const path = publicPath(row.path);
    if (id) material.id = id;
    if (type) material.type = type;
    if (title) material.title = title;
    if (url && /^https?:\/\//i.test(url)) material.url = url;
    if (path) material.path = path;
    return Object.keys(material).length ? [material] : [];
  });
}

async function activeSiteMetadata(channelId: string): Promise<Record<string, unknown>> {
  const row = await queryOne<{
    service_id: string; service_name: string; description: string; channel_name: string; config: Record<string, unknown> | null;
    deployment_id: string; deployment_version: number; source_snapshot: unknown; policy_snapshot: unknown; experience_snapshot: unknown;
  }>(
    `SELECT s.id AS service_id, s.name AS service_name, s.description, c.name AS channel_name, c.config,
            d.id AS deployment_id, d.version AS deployment_version, d.source_snapshot, d.policy_snapshot, d.experience_snapshot
       FROM ai_service_channels c
       JOIN ai_services s ON s.id=c.service_id AND s.status='active' AND s.current_deployment_id=c.active_deployment_id
       JOIN ai_service_deployments d ON d.id=c.active_deployment_id AND d.service_id=c.service_id AND d.status='active'
      WHERE c.id=$1 AND c.status='enabled' AND c.active_deployment_id IS NOT NULL`,
    [channelId],
  );
  if (!row) throw new ChannelCredentialError('AI Service website is not deployed', 404);
  const access = assertPublicSiteAccess({ config: row.config, allowMetadata: true });
  const policy = row.policy_snapshot && typeof row.policy_snapshot === 'object' && !Array.isArray(row.policy_snapshot) ? row.policy_snapshot as Record<string, unknown> : {};
  const source = row.source_snapshot && typeof row.source_snapshot === 'object' && !Array.isArray(row.source_snapshot) ? row.source_snapshot as Record<string, unknown> : {};
  const experience = row.experience_snapshot && typeof row.experience_snapshot === 'object' && !Array.isArray(row.experience_snapshot) ? row.experience_snapshot as Record<string, unknown> : {};
  const identity = experience.identity && typeof experience.identity === 'object' && !Array.isArray(experience.identity) ? experience.identity as Record<string, unknown> : {};
  const protectedMetadata = access.mode === 'password' || access.mode === 'login_required' || access.mode === 'disabled';
  return {
    serviceId: row.service_id,
    channelId,
    name: row.service_name,
    face: publicFace(identity.face || experience.face),
    description: row.description,
    channelName: row.channel_name,
    access: { mode: access.mode, hasPassword: access.hasPassword, requiresPassword: access.mode === 'password', requiresLogin: access.mode === 'login_required', disabled: access.mode === 'disabled' },
    ui: access.ui,
    deployment: { id: row.deployment_id, version: Number(row.deployment_version), status: 'active' },
    tools: protectedMetadata || !access.ui.showTools ? [] : Array.isArray(policy.allowedTools) ? policy.allowedTools.filter((item) => typeof item === 'string') : [],
    capabilities: protectedMetadata || !access.ui.showTools ? [] : Array.isArray(policy.capabilityIds) ? policy.capabilityIds.filter((item) => typeof item === 'string') : [],
    materials: protectedMetadata || !access.ui.showMaterials ? [] : publicMaterials(source),
    requestActions: protectedMetadata ? [] : publicRequestActions(experience),
  };
}

router.use(channelServingLimiter);

router.get('/sites/:channelId/metadata', async (req, res) => {
  try {
    const metadata = await activeSiteMetadata(req.params.channelId);
    const exposure = metadata.access && typeof metadata.access === 'object' && (metadata.access as Record<string, unknown>).mode === 'public' ? 'public' : 'unlisted';
    applyExposureHeaders(res, exposure);
    res.json(metadata);
  } catch (err) { fail(res, err); }
});

router.post('/sites/:channelId/conversations', async (req, res) => {
  try {
    const site = await activeSiteChannel(req.params.channelId, req.body?.accessPassword);
    const identity = resolvePublicVisitorIdentity(req, res, site.channelId);
    applyExposureHeaders(res, site.exposure);
    const conversation = await createAIServiceChannelConversation({
      serviceId: site.serviceId,
      channelId: site.channelId,
      tenantKey: identity.tenantKey,
      userKey: identity.userKey,
    });
    const resume = await issueConversationResumeGrant({ conversationId: conversation.id, serviceId: site.serviceId, channelId: site.channelId, tenantKey: identity.tenantKey, userKey: identity.userKey });
    await recordChannelUsageEvent({ serviceId: site.serviceId, channelId: site.channelId, conversationId: conversation.id, tenantKey: identity.tenantKey, userKey: identity.userKey, eventType: 'conversation_created', exposure: site.exposure, metadata: { route: 'public-site' } });
    res.status(201).json({ ...conversation, ...resume });
  } catch (err) { fail(res, err); }
});

router.post('/sites/:channelId/conversations/:conversationId/resume', async (req, res) => {
  try {
    const site = await activeSiteChannel(req.params.channelId, req.body?.accessPassword);
    const identity = resolvePublicVisitorIdentity(req, res, site.channelId);
    applyExposureHeaders(res, site.exposure);
    const resumed = await resumeConversation({
      conversationId: req.params.conversationId,
      channelId: site.channelId,
      tenantKey: identity.tenantKey,
      userKey: identity.userKey,
      resumeToken: text(req.body?.resumeToken, 'resumeToken'),
    });
    res.json(resumed);
  } catch (err) { fail(res, err); }
});

router.get('/sites/:channelId/conversations/:conversationId/files', async (req, res) => {
  try {
    const site = await activeSiteChannel(req.params.channelId, typeof req.query.accessPassword === 'string' ? req.query.accessPassword : undefined);
    const identity = resolvePublicVisitorIdentity(req, res, site.channelId);
    await resumeConversation({ conversationId: String(req.params.conversationId), channelId: site.channelId, tenantKey: identity.tenantKey, userKey: identity.userKey, resumeToken: text(req.query.resumeToken, 'resumeToken') });
    applyExposureHeaders(res, site.exposure);
    res.json({ files: await listConversationFiles({ channelId: site.channelId, conversationId: String(req.params.conversationId), tenantKey: identity.tenantKey, userKey: identity.userKey }) });
  } catch (err) { fail(res, err); }
});

router.post('/sites/:channelId/conversations/:conversationId/files', (req, res, next) => {
  conversationUpload.single('file')(req, res, (err) => err ? res.status(400).json({ error: err.message || 'File upload failed' }) : next());
}, async (req, res) => {
  const stagedPath = req.file?.path;
  try {
    if (!req.file) throw new ChannelCredentialError('file required', 400);
    const site = await activeSiteChannel(String(req.params.channelId), typeof req.body?.accessPassword === 'string' ? req.body.accessPassword : undefined);
    const identity = resolvePublicVisitorIdentity(req, res, site.channelId);
    await resumeConversation({ conversationId: String(req.params.conversationId), channelId: site.channelId, tenantKey: identity.tenantKey, userKey: identity.userKey, resumeToken: text(req.body?.resumeToken, 'resumeToken') });
    applyExposureHeaders(res, site.exposure);
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const conversationId = String(req.params.conversationId);
    const file = await saveConversationFile({ channelId: site.channelId, conversationId, tenantKey: identity.tenantKey, userKey: identity.userKey, stagedPath: req.file.path, originalName, mimeType: req.file.mimetype, sizeBytes: req.file.size });
    res.status(201).json(file);
  } catch (err) { fail(res, err); }
  finally { if (stagedPath) await fs.rm(stagedPath, { force: true }).catch(() => undefined); }
});

router.delete('/sites/:channelId/conversations/:conversationId/files/:fileId', async (req, res) => {
  try {
    const site = await activeSiteChannel(req.params.channelId, typeof req.query.accessPassword === 'string' ? req.query.accessPassword : undefined);
    const identity = resolvePublicVisitorIdentity(req, res, site.channelId);
    await resumeConversation({ conversationId: String(req.params.conversationId), channelId: site.channelId, tenantKey: identity.tenantKey, userKey: identity.userKey, resumeToken: text(req.query.resumeToken, 'resumeToken') });
    applyExposureHeaders(res, site.exposure);
    await deleteConversationFile({ fileId: String(req.params.fileId), channelId: site.channelId, conversationId: String(req.params.conversationId), tenantKey: identity.tenantKey, userKey: identity.userKey });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

router.post('/sites/:channelId/conversations/:conversationId/requests', async (req, res) => {
  try {
    const site = await activeSiteChannel(req.params.channelId, req.body?.accessPassword);
    const identity = resolvePublicVisitorIdentity(req, res, site.channelId);
    applyExposureHeaders(res, site.exposure);
    const request = await recordPublicCustomerRequest({
      channelId: site.channelId,
      conversationId: req.params.conversationId,
      tenantKey: identity.tenantKey,
      userKey: identity.userKey,
      actionId: text(req.body?.actionId, 'actionId'),
      subject: typeof req.body?.subject === 'string' ? req.body.subject : undefined,
      body: text(req.body?.body, 'body'),
      contact: req.body?.contact && typeof req.body.contact === 'object' && !Array.isArray(req.body.contact) ? req.body.contact : {},
      idempotencyKey: text(req.body?.idempotencyKey, 'idempotencyKey'),
    });
    await recordChannelUsageEvent({ serviceId: site.serviceId, channelId: site.channelId, conversationId: req.params.conversationId, tenantKey: identity.tenantKey, userKey: identity.userKey, eventType: 'customer_request_recorded', exposure: site.exposure, metadata: { route: 'public-site-request', actionId: req.body?.actionId } });
    res.status(201).json(request);
  } catch (err) { fail(res, err); }
});

router.post('/sites/:channelId/conversations/:conversationId/stream', async (req, res) => {
  const abort = new AbortController();
  req.on('close', () => abort.abort());
  try {
    const site = await activeSiteChannel(req.params.channelId, req.body?.accessPassword);
    const identity = resolvePublicVisitorIdentity(req, res, site.channelId);
    await assertChannelQuota({ serviceId: site.serviceId, channelId: site.channelId, tenantKey: identity.tenantKey });
    applyExposureHeaders(res, site.exposure);
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    writeNdjson(res, { type: 'start' });
    const response = await runAIServiceChannelTurn({
      serviceId: site.serviceId,
      channelId: site.channelId,
      conversationId: req.params.conversationId,
      tenantKey: identity.tenantKey,
      userKey: identity.userKey,
      prompt: text(req.body?.message, 'message'),
      userRole: 'ai_service_site_visitor',
      onTextUpdate: (value) => writeNdjson(res, { type: 'text', text: value }),
      signal: abort.signal,
    });
    await recordChannelUsageEvent({ serviceId: site.serviceId, channelId: site.channelId, conversationId: req.params.conversationId, tenantKey: identity.tenantKey, userKey: identity.userKey, eventType: 'message_turn', exposure: site.exposure, metadata: { route: 'public-site-stream' } });
    writeNdjson(res, { type: 'done', response });
    res.end();
  } catch (err) {
    writeNdjson(res, { type: 'error', error: err instanceof Error ? err.message : 'AI Service request failed' });
    res.end();
  }
});

router.post('/sites/:channelId/conversations/:conversationId/messages', async (req, res) => {
  try {
    const site = await activeSiteChannel(req.params.channelId, req.body?.accessPassword);
    const identity = resolvePublicVisitorIdentity(req, res, site.channelId);
    await assertChannelQuota({ serviceId: site.serviceId, channelId: site.channelId, tenantKey: identity.tenantKey });
    applyExposureHeaders(res, site.exposure);
    const response = await runAIServiceChannelTurn({
      serviceId: site.serviceId,
      channelId: site.channelId,
      conversationId: req.params.conversationId,
      tenantKey: identity.tenantKey,
      userKey: identity.userKey,
      prompt: text(req.body?.message, 'message'),
      userRole: 'ai_service_site_visitor',
    });
    await recordChannelUsageEvent({ serviceId: site.serviceId, channelId: site.channelId, conversationId: req.params.conversationId, tenantKey: identity.tenantKey, userKey: identity.userKey, eventType: 'message_turn', exposure: site.exposure, metadata: { route: 'public-site' } });
    res.json(response);
  } catch (err) { fail(res, err); }
});

router.post('/channels/:channelId/conversations', async (req, res) => {
  try {
    const token = credential(req);
    const claims = verifyChannelCredential(token, { channelId: req.params.channelId });
    await assertChannelCredentialNotRevoked(token);
    await assertChannelServingAccess({ serviceId: claims.serviceId, channelId: claims.channelId });
    applyExposureHeaders(res, claims.exposure);
    const conversation = await createAIServiceChannelConversation({
      serviceId: claims.serviceId,
      channelId: claims.channelId,
      tenantKey: claims.tenantKey,
      userKey: claims.userKey,
    });
    await recordChannelUsageEvent({ serviceId: claims.serviceId, channelId: claims.channelId, conversationId: conversation.id, tenantKey: claims.tenantKey, userKey: claims.userKey, eventType: 'conversation_created', exposure: claims.exposure, metadata: { route: 'public' } });
    res.status(201).json(conversation);
  } catch (err) { fail(res, err); }
});

router.post('/channels/:channelId/conversations/:conversationId/messages', async (req, res) => {
  try {
    const token = credential(req);
    const claims = verifyChannelCredential(token, { channelId: req.params.channelId });
    await assertChannelCredentialNotRevoked(token);
    await assertChannelServingAccess({ serviceId: claims.serviceId, channelId: claims.channelId });
    await assertChannelQuota({ serviceId: claims.serviceId, channelId: claims.channelId, tenantKey: claims.tenantKey });
    applyExposureHeaders(res, claims.exposure);
    const response = await runAIServiceChannelTurn({
      serviceId: claims.serviceId,
      channelId: claims.channelId,
      conversationId: req.params.conversationId,
      tenantKey: claims.tenantKey,
      userKey: claims.userKey,
      prompt: text(req.body?.message, 'message'),
      userRole: 'ai_service_channel',
    });
    await recordChannelUsageEvent({ serviceId: claims.serviceId, channelId: claims.channelId, conversationId: req.params.conversationId, tenantKey: claims.tenantKey, userKey: claims.userKey, eventType: 'message_turn', exposure: claims.exposure, metadata: { route: 'public' } });
    res.json(response);
  } catch (err) { fail(res, err); }
});

export default router;
