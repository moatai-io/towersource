/**
 * Owns: orchestration for resumable project uploads.
 * Public API: create/status/chunk/complete/cancel manager functions.
 * See README.md.
 */

import crypto from 'crypto';
import type { IncomingMessage } from 'http';
import path from 'path';
import { getProject } from '../pm/project-manager.js';
import { isPathSafe } from '../workspace/file-system.js';
import { isPathWritableByRole } from '../pm/project-access.js';
import {
  DEFAULT_RESUMABLE_UPLOAD_CHUNK_SIZE_BYTES,
  DEFAULT_UPLOAD_SESSION_TTL_HOURS,
  UploadHttpError,
  toNumber,
  type UploadManifestFile,
} from './resumable-upload-types.js';
import {
  createUploadSession,
  getUploadSession,
  getUploadSessionFile,
  getUploadSessionFiles,
  getUploadChunk,
  listUploadChunks,
  markFileCompleted,
  recordUploadChunk,
  updateSessionStatus,
} from './resumable-upload-store.js';
import { getProjectUploadQuota } from './resumable-upload-quota.js';
import { chunkExists, ensureSessionStaging, finalizeFile, removeSessionStaging, writeChunkStream } from './resumable-upload-storage.js';
import { normalizeRelativeUploadPath, resolveFinalUploadPath } from './resumable-upload-paths.js';

function chunkSizeBytes(): number {
  const mb = Number(process.env.RESUMABLE_UPLOAD_CHUNK_SIZE_MB || '');
  if (Number.isFinite(mb) && mb > 0) return Math.floor(mb * 1024 * 1024);
  return DEFAULT_RESUMABLE_UPLOAD_CHUNK_SIZE_BYTES;
}

function ttlHours(): number {
  const hours = Number(process.env.RESUMABLE_UPLOAD_SESSION_TTL_HOURS || '');
  if (Number.isFinite(hours) && hours > 0) return hours;
  return DEFAULT_UPLOAD_SESSION_TTL_HOURS;
}

async function getProjectOrThrow(projectId: string): Promise<NonNullable<Awaited<ReturnType<typeof getProject>>> & { rootPath: string }> {
  const project = await getProject(projectId);
  if (!project?.rootPath) throw new UploadHttpError(404, 'PROJECT_NOT_FOUND', 'Project not found');
  return project as NonNullable<Awaited<ReturnType<typeof getProject>>> & { rootPath: string };
}

async function assertWritableTarget(targetDir: string, userId: number, role: string | undefined): Promise<void> {
  if (!(await isPathWritableByRole(targetDir, userId, role || 'member'))) {
    throw new UploadHttpError(403, 'ACCESS_DENIED', 'Target directory is not writable');
  }
}

function responseFile(row: any, uploadedChunks: number[], chunkSize: number) {
  const size = toNumber(row.size);
  return {
    fileId: row.id,
    relativePath: row.relative_path,
    size,
    lastModified: row.last_modified === null ? null : toNumber(row.last_modified),
    sha256: row.sha256,
    status: row.status,
    chunkCount: Math.ceil(size / chunkSize),
    uploadedChunks,
    error: row.error,
  };
}

export async function createResumableUploadSession(params: {
  projectId: string;
  targetDir: string;
  files: unknown;
  userId: number;
  role?: string;
}) {
  const project = await getProjectOrThrow(params.projectId);
  const projectRoot = path.resolve(project.rootPath);
  const targetDir = path.resolve(params.targetDir);
  if (!isPathSafe(targetDir, projectRoot)) {
    throw new UploadHttpError(403, 'ACCESS_DENIED', 'Target directory must be inside the project');
  }
  await assertWritableTarget(targetDir, params.userId, params.role);

  if (!Array.isArray(params.files) || params.files.length === 0) {
    throw new UploadHttpError(400, 'INVALID_MANIFEST', 'files must be a non-empty array');
  }

  const seen = new Set<string>();
  const files: UploadManifestFile[] = params.files.map((raw: any) => {
    const relativePath = normalizeRelativeUploadPath(raw?.relativePath);
    if (seen.has(relativePath)) throw new UploadHttpError(400, 'INVALID_MANIFEST', `Duplicate relativePath: ${relativePath}`);
    seen.add(relativePath);
    const size = Number(raw?.size);
    if (!Number.isFinite(size) || size < 0) throw new UploadHttpError(400, 'INVALID_MANIFEST', `Invalid size for ${relativePath}`);
    // Validate final path escape now; complete validates again defensively.
    resolveFinalUploadPath(targetDir, relativePath);
    return {
      relativePath,
      size,
      lastModified: raw?.lastModified == null ? null : Number(raw.lastModified),
      sha256: typeof raw?.sha256 === 'string' ? raw.sha256 : null,
    };
  });

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const quota = await getProjectUploadQuota(project.id, projectRoot);
  if (totalBytes > quota.availableBytes) {
    throw new UploadHttpError(413, 'QUOTA_EXCEEDED', 'Project upload quota exceeded', { quota, requestedBytes: totalBytes });
  }

  const created = await createUploadSession({
    projectId: project.id,
    userId: params.userId,
    targetDir,
    chunkSize: chunkSizeBytes(),
    totalBytes,
    ttlHours: ttlHours(),
    files,
  });
  await ensureSessionStaging(projectRoot, created.session.id);
  return buildSessionResponse(created.session.id, projectRoot, quota);
}

export async function buildSessionResponse(sessionId: string, projectRoot?: string, quotaOverride?: any) {
  const session = await getUploadSession(sessionId);
  if (!session) throw new UploadHttpError(404, 'SESSION_NOT_FOUND', 'Upload session not found');
  const project = projectRoot ? null : await getProjectOrThrow(session.project_id);
  const effectiveProjectRoot = projectRoot || path.resolve(project!.rootPath);
  const files = await getUploadSessionFiles(sessionId);
  const chunks = await listUploadChunks(sessionId);
  const chunksByFile = new Map<string, number[]>();
  for (const chunk of chunks) {
    const arr = chunksByFile.get(chunk.file_id) || [];
    arr.push(chunk.chunk_index);
    chunksByFile.set(chunk.file_id, arr);
  }
  const quota = quotaOverride || await getProjectUploadQuota(session.project_id, effectiveProjectRoot);
  return {
    uploadSessionId: session.id,
    projectId: session.project_id,
    status: session.status,
    targetDir: session.target_dir,
    chunkSize: session.chunk_size,
    totalBytes: toNumber(session.total_bytes),
    uploadedBytes: toNumber(session.uploaded_bytes),
    expiresAt: session.expires_at,
    error: session.error,
    quota,
    files: files.map((f) => responseFile(f, chunksByFile.get(f.id) || [], session.chunk_size)),
  };
}

export async function uploadChunk(params: {
  sessionId: string;
  fileId: string;
  chunkIndex: number;
  contentLength: number;
  stream: IncomingMessage;
  userId: number;
  role?: string;
  chunkSha256?: string | null;
}) {
  const session = await getUploadSession(params.sessionId);
  if (!session) throw new UploadHttpError(404, 'SESSION_NOT_FOUND', 'Upload session not found');
  if (!['created', 'uploading', 'failed'].includes(session.status)) {
    throw new UploadHttpError(409, 'SESSION_NOT_UPLOADABLE', 'Session does not accept chunks');
  }
  const project = await getProjectOrThrow(session.project_id);
  await assertWritableTarget(session.target_dir, params.userId, params.role);
  const file = await getUploadSessionFile(params.sessionId, params.fileId);
  if (!file) throw new UploadHttpError(404, 'FILE_NOT_FOUND', 'File not found in session');

  const fileSize = toNumber(file.size);
  const chunkCount = Math.ceil(fileSize / session.chunk_size);
  if (!Number.isInteger(params.chunkIndex) || params.chunkIndex < 0 || params.chunkIndex >= chunkCount) {
    throw new UploadHttpError(400, 'BAD_CHUNK_INDEX', 'Chunk index out of range');
  }
  const expectedSize = params.chunkIndex === chunkCount - 1
    ? fileSize - session.chunk_size * (chunkCount - 1)
    : session.chunk_size;
  if (params.contentLength !== expectedSize) {
    throw new UploadHttpError(400, 'BAD_CHUNK_SIZE', 'Unexpected chunk size', { expectedSize, receivedSize: params.contentLength });
  }

  const projectRoot = path.resolve(project.rootPath);
  const existing = await getUploadChunk(params.sessionId, params.fileId, params.chunkIndex);
  if (existing) {
    if (existing.size === params.contentLength) {
      return { ok: true, idempotent: true, chunkIndex: params.chunkIndex, uploadedBytes: toNumber(session.uploaded_bytes) };
    }
    throw new UploadHttpError(409, 'CHUNK_CONFLICT', 'Chunk already exists with a different size');
  }
  const existingFile = await chunkExists(projectRoot, params.sessionId, params.fileId, params.chunkIndex);
  if (existingFile.exists) {
    if (existingFile.size !== params.contentLength) throw new UploadHttpError(409, 'CHUNK_CONFLICT', 'Chunk file already exists with a different size');
    await recordUploadChunk({ sessionId: params.sessionId, fileId: params.fileId, chunkIndex: params.chunkIndex, size: existingFile.size, sha256: params.chunkSha256 ?? null });
    return { ok: true, idempotent: true, chunkIndex: params.chunkIndex, uploadedBytes: toNumber(session.uploaded_bytes) + existingFile.size };
  }

  const quota = await getProjectUploadQuota(session.project_id, projectRoot);
  if (params.contentLength > quota.availableBytes) {
    throw new UploadHttpError(413, 'QUOTA_EXCEEDED', 'Project upload quota exceeded', { quota, requestedBytes: params.contentLength });
  }

  const written = await writeChunkStream({ projectRoot, sessionId: params.sessionId, fileId: params.fileId, chunkIndex: params.chunkIndex, stream: params.stream });
  let sha256: string | null = params.chunkSha256 ?? null;
  if (params.chunkSha256) {
    const actual = await hashFile(written.path);
    if (actual !== params.chunkSha256) throw new UploadHttpError(422, 'CHECKSUM_MISMATCH', 'Chunk checksum mismatch');
    sha256 = actual;
  }
  await recordUploadChunk({ sessionId: params.sessionId, fileId: params.fileId, chunkIndex: params.chunkIndex, size: written.size, sha256 });
  const updated = await getUploadSession(params.sessionId);
  return { ok: true, chunkIndex: params.chunkIndex, uploadedBytes: toNumber(updated?.uploaded_bytes) };
}

async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const fs = await import('fs');
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(filePath).on('data', (d) => hash.update(d)).on('error', reject).on('end', resolve);
  });
  return hash.digest('hex');
}

export async function completeUploadSession(params: { sessionId: string; userId: number; role?: string; overwrite?: boolean }) {
  const session = await getUploadSession(params.sessionId);
  if (!session) throw new UploadHttpError(404, 'SESSION_NOT_FOUND', 'Upload session not found');
  if (!['created', 'uploading', 'failed'].includes(session.status)) {
    throw new UploadHttpError(409, 'SESSION_NOT_COMPLETABLE', 'Session cannot be completed');
  }
  const project = await getProjectOrThrow(session.project_id);
  await assertWritableTarget(session.target_dir, params.userId, params.role);
  const projectRoot = path.resolve(project.rootPath);
  const files = await getUploadSessionFiles(params.sessionId);
  const chunks = await listUploadChunks(params.sessionId);
  const chunksByFile = new Map<string, Set<number>>();
  for (const chunk of chunks) {
    const set = chunksByFile.get(chunk.file_id) || new Set<number>();
    set.add(chunk.chunk_index);
    chunksByFile.set(chunk.file_id, set);
  }
  for (const file of files) {
    const chunkCount = Math.ceil(toNumber(file.size) / session.chunk_size);
    const set = chunksByFile.get(file.id) || new Set<number>();
    for (let i = 0; i < chunkCount; i++) {
      if (!set.has(i)) throw new UploadHttpError(409, 'MISSING_CHUNKS', `Missing chunk ${i} for ${file.relative_path}`);
    }
    resolveFinalUploadPath(session.target_dir, file.relative_path);
  }

  await updateSessionStatus(params.sessionId, 'completing');
  try {
    const results = [];
    for (const file of files) {
      const chunkCount = Math.ceil(toNumber(file.size) / session.chunk_size);
      const finalized = await finalizeFile({
        projectRoot,
        sessionId: params.sessionId,
        fileId: file.id,
        targetDir: session.target_dir,
        relativePath: file.relative_path,
        chunkCount,
        overwrite: Boolean(params.overwrite),
      });
      await markFileCompleted(params.sessionId, file.id);
      results.push({ relativePath: file.relative_path, path: finalized.finalPath, size: finalized.size });
    }
    await updateSessionStatus(params.sessionId, 'completed');
    await removeSessionStaging(projectRoot, params.sessionId);
    return { ok: true, uploadSessionId: params.sessionId, projectId: session.project_id, results };
  } catch (err: any) {
    await updateSessionStatus(params.sessionId, 'failed', err?.message || 'Finalize failed');
    if (err?.code === 'PATH_CONFLICT') throw new UploadHttpError(409, 'PATH_CONFLICT', 'Final path already exists');
    throw err;
  }
}

export async function cancelUploadSession(params: { sessionId: string; userId: number; role?: string }) {
  const session = await getUploadSession(params.sessionId);
  if (!session) throw new UploadHttpError(404, 'SESSION_NOT_FOUND', 'Upload session not found');
  const project = await getProjectOrThrow(session.project_id);
  await assertWritableTarget(session.target_dir, params.userId, params.role);
  await updateSessionStatus(params.sessionId, 'cancelled');
  await removeSessionStaging(path.resolve(project.rootPath), params.sessionId);
  return { ok: true, status: 'cancelled' };
}
