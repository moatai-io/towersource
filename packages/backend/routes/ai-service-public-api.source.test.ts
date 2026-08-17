import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './ai-service-public-api.ts'), 'utf8');

const api = fs.readFileSync(path.resolve(import.meta.dirname, './api.ts'), 'utf8');

describe('AI Service public Channel serving API source contract', () => {
  it('stores Conversation uploads through a disk-staged public route without exposing paths', () => {
    expect(source).toContain("conversationUpload.single('file')");
    expect(source).toContain("res.status(400).json({ error: err.message || 'File upload failed' })");
    expect(source).toContain("'upload-staging', 'ai-service-conversation-files'");
    expect(source).toContain('multer.diskStorage');
    expect(source).toContain('saveConversationFile');
    expect(source).toContain('listConversationFiles');
    expect(source).toContain('deleteConversationFile');
    expect(source).toContain("resumeToken: text(req.body?.resumeToken, 'resumeToken')");
    expect(source).toContain("resumeToken: text(req.query.resumeToken, 'resumeToken')");
    expect(source).not.toContain('multer.memoryStorage');
  });

  it('is mounted before Tower auth and supports both stable website and credential routes', () => {
    expect(api.indexOf("router.use('/ai-service-public', aiServicePublicRouter)")).toBeLessThan(api.indexOf('router.use(authMiddleware)'));
    expect(api).toContain("if (config.aiServicesEnabled) router.use('/ai-service-public', aiServicePublicRouter)");
    expect(source).toContain("/sites/:channelId/metadata");
    expect(source).toContain("/sites/:channelId/conversations");
    expect(source).toContain("/sites/:channelId/metadata");
    expect(source).toContain('activeSiteChannel');
    expect(source).toContain('activeSiteMetadata');
    expect(source).toContain('credentialFromAuthHeader');
    expect(source).toContain('verifyChannelCredential');
  });

  it('uses signed credential claims and signed browser visitor identity rather than request-body or IP identity', () => {
    expect(source).toContain('tenantKey: claims.tenantKey');
    expect(source).toContain('userKey: claims.userKey');
    expect(source).toContain('resolvePublicVisitorIdentity(req, res, site.channelId)');
    expect(source).not.toContain('req.body?.tenantKey');
    expect(source).not.toContain('req.body?.userKey');
    expect(source).not.toContain('visitorIdentity(req)');
    expect(source).not.toContain('visitor:${key}');
  });

  it('keeps public traffic behind active channel checks, revocation where credentialed, quota, rate limit, pinned runtime, and usage ledger', () => {
    expect(source).toContain('rateLimit');
    expect(source).toContain('assertChannelCredentialNotRevoked');
    expect(source).toContain('assertChannelQuota');
    expect(source).toContain('createAIServiceChannelConversation');
    expect(source).toContain('runAIServiceChannelTurn');
    expect(source).toContain('recordChannelUsageEvent');
    expect(source).toContain('issueConversationResumeGrant');
    expect(source).toContain('/sites/:channelId/conversations/:conversationId/resume');
    expect(source).toContain('resumeConversation');
    expect(source).toContain('assertPublicSiteAccess');
    expect(source).toContain('assertChannelServingAccess');
    expect(source).toContain("route: 'public-site'");
    expect(source).toContain('policy.allowedTools');
    expect(source).toContain('source.refs');
    expect(source).toContain("eventType: 'conversation_created'");
    expect(source).toContain("eventType: 'message_turn'");
  });

  it('streams public website responses as abortable NDJSON without changing credential routes', () => {
    expect(source).toContain('/sites/:channelId/conversations/:conversationId/stream');
    expect(source).toContain("Content-Type', 'application/x-ndjson; charset=utf-8'");
    expect(source).toContain("X-Accel-Buffering', 'no'");
    expect(source).toContain('writeNdjson');
    expect(source).toContain("type: 'text'");
    expect(source).toContain('onTextUpdate');
    expect(source).toContain('signal: abort.signal');
    expect(source).toContain("req.on('close', () => abort.abort())");
  });

  it('applies cache and robots headers according to exposure', () => {
    expect(source).toContain('applyExposureHeaders');
    expect(source).toContain("Cache-Control', 'no-store'");
    expect(source).toContain("X-Robots-Tag', 'noindex'");
    expect(source).toContain("exposure !== 'public'");
  });

  it('returns only public-safe site metadata for UI transparency panels', () => {
    expect(source).toContain('activeSiteMetadata');
    expect(source).toContain('source_snapshot');
    expect(source).toContain('policy_snapshot');
    expect(source).toContain('experience_snapshot');
    expect(source).toContain('publicFace');
    expect(source).toContain('allowedTools');
    expect(source).toContain('capabilityIds');
    expect(source).toContain('materials');
    expect(source).toContain('face: publicFace');
    expect(source).toContain('source.refs');
    expect(source).toContain('protectedMetadata');
    expect(source).toContain('allowMetadata: true');
    expect(source).toContain('ui: access.ui');
    expect(source).toContain('!access.ui.showTools');
    expect(source).toContain('!access.ui.showMaterials');
    expect(source).toContain('requiresPassword');
    expect(source).toContain('requiresLogin');
    expect(source).not.toContain('root_path');
  });
});
