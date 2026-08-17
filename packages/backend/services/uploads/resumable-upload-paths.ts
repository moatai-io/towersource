/**
 * Owns: path normalization for resumable project uploads.
 * Public API: normalizeRelativeUploadPath, staging path helpers.
 * See README.md.
 */

import path from 'path';
import { UploadHttpError } from './resumable-upload-types.js';

/** Normalize a browser-provided relative path and reject path escapes. */
export function normalizeRelativeUploadPath(input: unknown): string {
  if (typeof input !== 'string') {
    throw new UploadHttpError(400, 'INVALID_RELATIVE_PATH', 'relativePath must be a string');
  }
  const trimmed = input.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  const segments = trimmed.split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new UploadHttpError(400, 'INVALID_RELATIVE_PATH', 'relativePath cannot be empty');
  }
  if (segments.some((s) => s === '..' || s === '.' || s.includes('\0'))) {
    throw new UploadHttpError(400, 'INVALID_RELATIVE_PATH', 'relativePath contains an invalid segment');
  }
  const normalized = segments.join('/');
  if (path.isAbsolute(normalized)) {
    throw new UploadHttpError(400, 'INVALID_RELATIVE_PATH', 'relativePath cannot be absolute');
  }
  return normalized;
}

/** Ensure target paths stay under the selected target directory. */
export function resolveFinalUploadPath(targetDir: string, relativePath: string): string {
  const resolvedTarget = path.resolve(targetDir);
  const resolved = path.resolve(resolvedTarget, relativePath);
  if (resolved !== resolvedTarget && !resolved.startsWith(resolvedTarget + path.sep)) {
    throw new UploadHttpError(403, 'ACCESS_DENIED', 'Resolved upload path escapes target directory');
  }
  return resolved;
}

export function uploadRootForProject(projectRoot: string): string {
  return path.join(projectRoot, 'uploads');
}

export function stagingRootForProject(projectRoot: string): string {
  return path.join(uploadRootForProject(projectRoot), '.staging');
}

export function stagingRootForSession(projectRoot: string, sessionId: string): string {
  return path.join(stagingRootForProject(projectRoot), sessionId);
}

export function chunkPath(projectRoot: string, sessionId: string, fileId: string, chunkIndex: number): string {
  return path.join(stagingRootForSession(projectRoot, sessionId), 'files', fileId, 'chunks', `${String(chunkIndex).padStart(8, '0')}.part`);
}

export function chunkTmpPath(projectRoot: string, sessionId: string, fileId: string, chunkIndex: number): string {
  return `${chunkPath(projectRoot, sessionId, fileId, chunkIndex)}.tmp-${process.pid}-${Date.now()}`;
}
