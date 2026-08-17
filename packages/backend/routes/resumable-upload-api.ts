/**
 * resumable-upload-api.ts — Project-scoped resumable upload endpoints.
 *
 * Owns: session/create/status/chunk/complete/cancel API for large folder uploads.
 * Public API: router mounted under /api/files/resumable-upload.
 */

import { Router } from 'express';
import {
  buildSessionResponse,
  cancelUploadSession,
  completeUploadSession,
  createResumableUploadSession,
  uploadChunk,
} from '../services/uploads/resumable-upload-manager.js';
import { getProject } from '../services/pm/project-manager.js';
import { isProjectMember } from '../services/pm/project-membership-manager.js';
import { isPrivilegedRole } from '../services/pm/project-access.js';
import { getProjectUploadQuota } from '../services/uploads/resumable-upload-quota.js';
import { UploadHttpError } from '../services/uploads/resumable-upload-types.js';
import { appendFileTransferEventSafe } from '../services/workspace/file-transfer-audit.js';

const router = Router();

function reqUser(req: any): { userId: number; role: string | undefined } {
  const userId = req.user?.userId;
  if (!userId) throw new UploadHttpError(401, 'AUTH_REQUIRED', 'Auth required');
  return { userId, role: req.user?.role };
}

async function assertProjectAccess(req: any, projectId: string): Promise<void> {
  const { userId, role } = reqUser(req);
  if (isPrivilegedRole(role)) return;
  if (await isProjectMember(projectId, userId)) return;
  throw new UploadHttpError(403, 'ACCESS_DENIED', 'Access denied: not a project member');
}

function sendError(res: any, err: any): void {
  if (err instanceof UploadHttpError) {
    res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
    return;
  }
  console.error('[resumable-upload] unexpected error:', err);
  res.status(500).json({ error: err?.message || 'Internal upload error', code: 'INTERNAL_ERROR' });
}

router.post('/sessions', async (req, res) => {
  try {
    const { userId, role } = reqUser(req);
    const projectId = String(req.body?.projectId || '');
    if (!projectId) throw new UploadHttpError(400, 'PROJECT_ID_REQUIRED', 'projectId required');
    await assertProjectAccess(req, projectId);
    const result = await createResumableUploadSession({
      projectId,
      targetDir: String(req.body?.targetDir || ''),
      files: req.body?.files,
      userId,
      role,
    });
    res.status(201).json(result);
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/sessions/:sessionId', async (req, res) => {
  try {
    const result = await buildSessionResponse(req.params.sessionId);
    await assertProjectAccess(req, result.projectId);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

router.put('/sessions/:sessionId/files/:fileId/chunks/:chunkIndex', async (req, res) => {
  try {
    const { userId, role } = reqUser(req);
    const contentLength = Number(req.headers['content-length']);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      throw new UploadHttpError(411, 'CONTENT_LENGTH_REQUIRED', 'Content-Length required');
    }
    const chunkIndex = Number(req.params.chunkIndex);
    const result = await uploadChunk({
      sessionId: req.params.sessionId,
      fileId: req.params.fileId,
      chunkIndex,
      contentLength,
      stream: req,
      userId,
      role,
      chunkSha256: typeof req.headers['x-chunk-sha256'] === 'string' ? req.headers['x-chunk-sha256'] : null,
    });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/sessions/:sessionId/complete', async (req, res) => {
  try {
    const { userId, role } = reqUser(req);
    const result = await completeUploadSession({
      sessionId: req.params.sessionId,
      userId,
      role,
      overwrite: Boolean(req.body?.overwrite),
    });
    appendFileTransferEventSafe({
      actorUserId: userId,
      projectId: result.projectId,
      direction: 'upload',
      transferKind: 'resumable',
      paths: result.results.map((item: any) => item.path),
      itemCount: result.results.length,
      totalBytes: result.results.reduce((sum: number, item: any) => sum + Number(item.size || 0), 0),
      metadata: { uploadSessionId: result.uploadSessionId },
    });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const { userId, role } = reqUser(req);
    const result = await cancelUploadSession({ sessionId: req.params.sessionId, userId, role });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/projects/:projectId/quota', async (req, res) => {
  try {
    await assertProjectAccess(req, req.params.projectId);
    const project = await getProject(req.params.projectId);
    if (!project?.rootPath) throw new UploadHttpError(404, 'PROJECT_NOT_FOUND', 'Project not found');
    res.json({ projectId: project.id, ...(await getProjectUploadQuota(project.id, project.rootPath)) });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
