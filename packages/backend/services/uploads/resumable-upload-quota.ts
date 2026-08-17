/**
 * Owns: project upload quota calculation.
 * Public API: getProjectUploadQuota.
 * See README.md.
 */

import path from 'path';
import { config } from '../../config.js';
import { activeReservedBytes } from './resumable-upload-store.js';
import { directorySizeBytes } from './resumable-upload-storage.js';
import { DEFAULT_PROJECT_UPLOAD_QUOTA_BYTES, type UploadQuotaSnapshot } from './resumable-upload-types.js';
import { uploadRootForProject } from './resumable-upload-paths.js';

export function projectUploadQuotaLimitBytes(): number {
  const mb = Number(process.env.PROJECT_UPLOAD_QUOTA_MB || '');
  if (Number.isFinite(mb) && mb > 0) return Math.floor(mb * 1024 * 1024);
  return DEFAULT_PROJECT_UPLOAD_QUOTA_BYTES;
}

export async function getProjectUploadQuota(projectId: string, projectRoot: string): Promise<UploadQuotaSnapshot> {
  const limitBytes = projectUploadQuotaLimitBytes();
  const uploadsRoot = uploadRootForProject(projectRoot);
  const usedBytes = await directorySizeBytes(uploadsRoot, { excludeDirNames: new Set(['.staging']) });
  const reservedBytes = await activeReservedBytes(projectId);
  return {
    limitBytes,
    usedBytes,
    reservedBytes,
    availableBytes: Math.max(0, limitBytes - usedBytes - reservedBytes),
  };
}

export function isUnderWorkspaceRoot(projectRoot: string): boolean {
  const workspaceRoot = path.resolve(config.workspaceRoot);
  const resolved = path.resolve(projectRoot);
  return resolved === workspaceRoot || resolved.startsWith(workspaceRoot + path.sep);
}
