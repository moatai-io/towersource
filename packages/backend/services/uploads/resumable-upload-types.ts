/**
 * Owns: shared types and constants for project resumable uploads.
 * Public API: constants, row types, request manifest types.
 * See README.md.
 */

export const DEFAULT_RESUMABLE_UPLOAD_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_PROJECT_UPLOAD_QUOTA_BYTES = 4 * 1024 * 1024 * 1024;
export const DEFAULT_UPLOAD_SESSION_TTL_HOURS = 72;

export type UploadSessionStatus = 'created' | 'uploading' | 'completing' | 'completed' | 'cancelled' | 'expired' | 'failed';
export type UploadFileStatus = 'pending' | 'uploading' | 'uploaded' | 'completed' | 'failed';

export interface UploadManifestFile {
  relativePath: string;
  size: number;
  lastModified?: number | null;
  sha256?: string | null;
}

export interface UploadSessionRow {
  id: string;
  project_id: string;
  user_id: number;
  target_dir: string;
  status: UploadSessionStatus;
  chunk_size: number;
  total_bytes: string | number;
  uploaded_bytes: string | number;
  error: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface UploadSessionFileRow {
  id: string;
  session_id: string;
  relative_path: string;
  size: string | number;
  last_modified: string | number | null;
  sha256: string | null;
  status: UploadFileStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface UploadChunkRow {
  session_id: string;
  file_id: string;
  chunk_index: number;
  size: number;
  sha256: string | null;
  created_at: string;
}

export interface UploadQuotaSnapshot {
  limitBytes: number;
  usedBytes: number;
  reservedBytes: number;
  availableBytes: number;
}

export class UploadHttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function toNumber(value: string | number | null | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  return 0;
}
