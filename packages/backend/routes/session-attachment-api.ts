// Owns: authenticated HTTP boundary for session-scoped attachments and explicit promotion.
import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { config } from '../config.js';
import {
  deleteSessionAttachment,
  listSessionAttachments,
  promoteSessionAttachmentToPersonal,
  promoteSessionAttachmentToProject,
  resolveReadableSessionAttachment,
  resolveSessionAttachment,
  SessionAttachmentError,
} from '../services/session-attachments/session-attachment-store.js';
import { queryOne } from '../db/pg-repo.js';
import { canAccessSession, isPathWritableByRole } from '../services/pm/project-access.js';
import { getProject } from '../services/pm/project-manager.js';

const router = Router();
const stagingDir = path.join(config.dataDir, 'upload-staging', 'session-attachments');
const upload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      fs.mkdir(stagingDir, { recursive: true })
        .then(() => cb(null, stagingDir))
        .catch(error => cb(error, stagingDir));
    },
    filename(_req, _file, cb) { cb(null, `${Date.now()}-${crypto.randomUUID()}.upload`); },
  }),
  limits: { fileSize: 200 * 1024 * 1024, files: 20 },
});

function stagedFiles(req: any): Express.Multer.File[] {
  return Array.isArray(req.files) ? req.files as Express.Multer.File[] : [];
}

async function cleanupStagedFiles(req: any): Promise<void> {
  await Promise.all(stagedFiles(req)
    .filter(file => typeof file.path === 'string' && file.path.startsWith(path.resolve(stagingDir) + path.sep))
    .map(file => fs.rm(file.path, { force: true }).catch(() => undefined)));
}

function withStagingCleanup(req: any, res: any, next: (error?: unknown) => void) {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    void cleanupStagedFiles(req);
  };
  res.once('finish', cleanup);
  res.once('close', cleanup);
  next();
}

function user(req: any): { id: number; role: string } {
  const id = Number(req.user?.userId);
  if (!Number.isInteger(id) || id <= 0) throw new SessionAttachmentError('FORBIDDEN', 'Authenticated user required');
  return { id, role: String(req.user?.role || 'member') };
}

async function assertSessionWritable(userId: number, role: string, sessionId: string): Promise<{ projectId: string | null }> {
  if (role === 'viewer' || role === 'guest') {
    throw new SessionAttachmentError('FORBIDDEN', 'Session attachment write access denied');
  }
  const access = await canAccessSession(sessionId, userId, role);
  if (!access.allowed) throw new SessionAttachmentError(access.status === 404 ? 'NOT_FOUND' : 'FORBIDDEN', access.message);
  const row = await queryOne<{ project_id: string | null }>('SELECT project_id FROM sessions WHERE id = $1', [sessionId]);
  if (!row) throw new SessionAttachmentError('NOT_FOUND', 'Session not found');
  return { projectId: row.project_id };
}

async function assertSessionReadable(userId: number, role: string, sessionId: string): Promise<void> {
  const access = await canAccessSession(sessionId, userId, role);
  if (!access.allowed) throw new SessionAttachmentError(access.status === 404 ? 'NOT_FOUND' : 'FORBIDDEN', access.message);
}

function fail(res: any, error: unknown) {
  if (error instanceof SessionAttachmentError) {
    const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'EXPIRED' ? 410 : error.code === 'CONFLICT' ? 409 : 403;
    return res.status(status).json({ error: error.message, code: error.code });
  }
  console.error('[session-attachments]', error);
  return res.status(500).json({ error: error instanceof Error ? error.message : 'Session attachment error' });
}

const MAX_UPLOAD_REQUEST_BYTES = 220 * 1024 * 1024;

function safeProjectUploadName(input: string): string {
  const base = path.basename(String(input || '').trim()).replace(/[\\/:*?"<>|\0]/g, '-').slice(0, 240);
  if (!base || base === '.' || base === '..') throw new SessionAttachmentError('INVALID', 'Attachment filename required');
  return base;
}

function uniqueProjectUploadName(name: string): string {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  return `${stem}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${ext}`;
}

async function commitStagedProjectUpload(input: {
  sourcePath: string;
  originalName: string;
  mimeType?: string | null;
  sizeBytes: number;
  projectId: string;
  userId: number;
  userRole: string;
}) {
  const project = await getProject(input.projectId);
  if (!project?.rootPath) throw new SessionAttachmentError('NOT_FOUND', 'Project not found');
  const targetDir = path.join(project.rootPath, 'uploads');
  if (!await isPathWritableByRole(targetDir, input.userId, input.userRole)) {
    throw new SessionAttachmentError('FORBIDDEN', 'Project upload access denied');
  }
  await fs.mkdir(targetDir, { recursive: true });
  const name = safeProjectUploadName(input.originalName);
  let target = path.join(targetDir, name);
  try { await fs.access(target); target = path.join(targetDir, uniqueProjectUploadName(name)); } catch {}
  const temporaryTarget = `${target}.tower-upload-${crypto.randomUUID()}.tmp`;
  try {
    await fs.copyFile(input.sourcePath, temporaryTarget, fs.constants.COPYFILE_EXCL);
    await fs.rename(temporaryTarget, target);
  } catch (error) {
    await fs.rm(temporaryTarget, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    id: crypto.randomUUID(),
    uri: target,
    name: path.basename(target),
    mimeType: input.mimeType || null,
    sizeBytes: input.sizeBytes,
    status: 'project_file' as const,
    promotedUri: target,
    expiresAt: null,
    createdAt: new Date().toISOString(),
  };
}

function rejectOversizedUploadRequest(req: any, res: any, next: any) {
  const contentLength = Number(req.headers?.['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_REQUEST_BYTES) {
    return res.status(413).json({ error: 'Upload batch is too large; send fewer files per request' });
  }
  next();
}

router.post('/:sessionId', rejectOversizedUploadRequest, upload.array('files', 20), withStagingCleanup, async (req: any, res) => {
  try {
    const actor = user(req);
    const session = await assertSessionWritable(actor.id, actor.role, req.params.sessionId);
    if (!session.projectId) {
      throw new SessionAttachmentError('CONFLICT', 'Chat uploads require a project-connected session');
    }
    const files = (req.files || []) as Express.Multer.File[];
    if (files.length === 0) return res.status(400).json({ error: 'No files provided' });
    const attachments = [];
    const failures: Array<{ name: string; error: string }> = [];
    for (const file of files) {
      file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
      try {
        const attachment = await commitStagedProjectUpload({
          sourcePath: file.path,
          originalName: file.originalname,
          mimeType: file.mimetype,
          sizeBytes: file.size,
          projectId: session.projectId,
          userId: actor.id,
          userRole: actor.role,
        });
        attachments.push(attachment);
      } catch (error) {
        failures.push({
          name: file.originalname,
          error: error instanceof Error ? error.message : 'Upload failed',
        });
      } finally {
        if (file.path) await fs.rm(file.path, { force: true }).catch(() => undefined);
      }
    }
    const status = failures.length > 0 ? 207 : 200;
    res.status(status).json({ attachments, failures });
  } catch (error) { fail(res, error); }
});

router.get('/:sessionId', async (req: any, res) => {
  try {
    const actor = user(req);
    await assertSessionReadable(actor.id, actor.role, req.params.sessionId);
    res.json({ attachments: await listSessionAttachments(actor.id, req.params.sessionId) });
  } catch (error) { fail(res, error); }
});

router.get('/:sessionId/:attachmentId', async (req: any, res) => {
  try {
    const actor = user(req);
    await assertSessionReadable(actor.id, actor.role, req.params.sessionId);
    const item = await resolveReadableSessionAttachment(req.params.sessionId, req.params.attachmentId);
    res.json({ attachment: item.document });
  } catch (error) { fail(res, error); }
});

router.get('/:sessionId/:attachmentId/content', async (req: any, res) => {
  try {
    const actor = user(req);
    await assertSessionReadable(actor.id, actor.role, req.params.sessionId);
    const item = await resolveReadableSessionAttachment(req.params.sessionId, req.params.attachmentId);
    res.type(item.document.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(item.document.name)}`);
    res.sendFile(item.path);
  } catch (error) { fail(res, error); }
});

router.delete('/:sessionId/:attachmentId', async (req: any, res) => {
  try {
    const actor = user(req);
    await assertSessionWritable(actor.id, actor.role, req.params.sessionId);
    await deleteSessionAttachment(actor.id, req.params.sessionId, req.params.attachmentId);
    res.json({ ok: true });
  } catch (error) { fail(res, error); }
});

router.post('/:sessionId/:attachmentId/promote', async (req: any, res) => {
  try {
    const actor = user(req);
    const session = await assertSessionWritable(actor.id, actor.role, req.params.sessionId);
    const destination = req.body?.destination;
    const name = typeof req.body?.name === 'string' ? req.body.name : undefined;
    const attachment = destination === 'personal'
      ? await promoteSessionAttachmentToPersonal({ userId: actor.id, sessionId: req.params.sessionId, attachmentId: req.params.attachmentId, requestedName: name })
      : destination === 'project'
        ? await promoteSessionAttachmentToProject({
            userId: actor.id,
            userRole: actor.role,
            sessionId: req.params.sessionId,
            attachmentId: req.params.attachmentId,
            projectId: String(req.body?.projectId || session.projectId || ''),
            requestedName: name,
          })
        : null;
    if (!attachment) return res.status(400).json({ error: 'destination must be personal or project' });
    res.json({ ok: true, attachment, destination, uri: attachment.promotedUri });
  } catch (error) { fail(res, error); }
});

export default router;
