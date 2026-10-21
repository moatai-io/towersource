// Owns: authenticated HTTP boundary for session-scoped attachments and explicit promotion.
import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { config } from '../config.js';
import {
  createSessionAttachmentFromPath,
  deleteSessionAttachment,
  listSessionAttachments,
  promoteSessionAttachmentToProject,
  resolveReadableSessionAttachment,
  resolveSessionAttachment,
  SessionAttachmentError,
} from '../services/session-attachments/session-attachment-store.js';
import { queryOne } from '../db/pg-repo.js';
import { canAccessSession, canWriteSessionContent } from '../services/pm/project-access.js';

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
  const access = await canWriteSessionContent(sessionId, userId, role);
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

function rejectOversizedUploadRequest(req: any, res: any, next: any) {
  const contentLength = Number(req.headers?.['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_REQUEST_BYTES) {
    return res.status(413).json({ error: 'Upload batch is too large; send fewer files per request' });
  }
  next();
}

export function handleSessionAttachmentUpload(req: any, res: any, next: any) {
  upload.array('files', 20)(req, res, async (error: any) => {
    if (!error) return next();
    await cleanupStagedFiles(req);
    const oversized = error.code === 'LIMIT_FILE_SIZE' || error.code === 'LIMIT_FILE_COUNT';
    res.status(oversized ? 413 : 400).json({
      code: oversized ? error.code : 'UPLOAD_INTAKE_FAILED',
      error: oversized ? 'Upload limit exceeded (200MB per file, 20 files per request)' : 'Upload intake failed; please try again',
    });
  });
}

router.post('/:sessionId', rejectOversizedUploadRequest, handleSessionAttachmentUpload, withStagingCleanup, async (req: any, res) => {
  try {
    const actor = user(req);
    const session = await assertSessionWritable(actor.id, actor.role, req.params.sessionId);
    const files = (req.files || []) as Express.Multer.File[];
    if (files.length === 0) return res.status(400).json({ error: 'No files provided' });
    const attachments = [];
    const failures: Array<{ name: string; error: string }> = [];
    for (const file of files) {
      file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
      try {
        const attachment = await createSessionAttachmentFromPath({
          sourcePath: file.path,
          name: file.originalname,
          mimeType: file.mimetype,
          sessionId: req.params.sessionId,
          projectId: session.projectId,
          userId: actor.id,
        });
        attachments.push(attachment);
      } catch (error) {
        failures.push({
          name: file.originalname,
          error: (error as NodeJS.ErrnoException).code === 'ENAMETOOLONG'
            ? 'Filename is too long; rename the file and retry'
            : (error as NodeJS.ErrnoException).code === 'ENOSPC'
              ? 'Storage is full; ask an administrator to free space'
            : ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code || '')
              ? 'Storage access denied; ask an administrator to check permissions'
            : error instanceof SessionAttachmentError ? error.message
            : error instanceof Error && error.message.startsWith('WORKER_')
              ? 'Project Worker could not save the file; please retry when the Worker is available'
              : 'Could not save the file; ask an administrator to check storage permissions and free space',
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
    const attachment = destination === 'project'
      ? await promoteSessionAttachmentToProject({
          userId: actor.id,
          userRole: actor.role,
          sessionId: req.params.sessionId,
          attachmentId: req.params.attachmentId,
          projectId: String(req.body?.projectId || session.projectId || ''),
          requestedName: name,
        })
      : null;
    if (!attachment) return res.status(400).json({ error: 'destination must be project' });
    res.json({ ok: true, attachment, destination, uri: attachment.promotedUri });
  } catch (error) { fail(res, error); }
});

export default router;
