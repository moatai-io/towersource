/**
 * Owns: PostgreSQL persistence for resumable uploads.
 * Public API: CRUD helpers for sessions, files, and chunks.
 * See README.md.
 */

import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, transaction, withClient } from '../../db/pg-repo.js';
import type { UploadSessionFileRow, UploadSessionRow, UploadChunkRow, UploadManifestFile } from './resumable-upload-types.js';

function newId(prefix: string): string {
  return `${prefix}_${uuidv4()}`;
}

export async function createUploadSession(params: {
  projectId: string;
  userId: number;
  targetDir: string;
  chunkSize: number;
  totalBytes: number;
  ttlHours: number;
  files: UploadManifestFile[];
}): Promise<{ session: UploadSessionRow; files: UploadSessionFileRow[] }> {
  const sessionId = newId('upl');
  return transaction(async (client) => {
    const db = withClient(client);
    const session = await db.queryOne<UploadSessionRow>(`
      INSERT INTO upload_sessions (id, project_id, user_id, target_dir, status, chunk_size, total_bytes, expires_at)
      VALUES ($1, $2, $3, $4, 'created', $5, $6, now() + ($7 || ' hours')::interval)
      RETURNING *
    `, [sessionId, params.projectId, params.userId, params.targetDir, params.chunkSize, params.totalBytes, params.ttlHours]);
    if (!session) throw new Error('failed to create upload session');

    const rows: UploadSessionFileRow[] = [];
    for (const file of params.files) {
      const row = await db.queryOne<UploadSessionFileRow>(`
        INSERT INTO upload_session_files (id, session_id, relative_path, size, last_modified, sha256, status)
        VALUES ($1, $2, $3, $4, $5, $6, 'pending')
        RETURNING *
      `, [newId('ulf'), sessionId, file.relativePath, file.size, file.lastModified ?? null, file.sha256 ?? null]);
      if (!row) throw new Error('failed to create upload session file');
      rows.push(row);
    }

    return { session, files: rows };
  });
}

export async function getUploadSession(sessionId: string): Promise<UploadSessionRow | undefined> {
  return queryOne<UploadSessionRow>('SELECT * FROM upload_sessions WHERE id = $1', [sessionId]);
}

export async function getUploadSessionFiles(sessionId: string): Promise<UploadSessionFileRow[]> {
  return query<UploadSessionFileRow>('SELECT * FROM upload_session_files WHERE session_id = $1 ORDER BY relative_path', [sessionId]);
}

export async function getUploadSessionFile(sessionId: string, fileId: string): Promise<UploadSessionFileRow | undefined> {
  return queryOne<UploadSessionFileRow>('SELECT * FROM upload_session_files WHERE session_id = $1 AND id = $2', [sessionId, fileId]);
}

export async function listUploadChunks(sessionId: string, fileId?: string): Promise<UploadChunkRow[]> {
  if (fileId) {
    return query<UploadChunkRow>('SELECT * FROM upload_chunks WHERE session_id = $1 AND file_id = $2 ORDER BY chunk_index', [sessionId, fileId]);
  }
  return query<UploadChunkRow>('SELECT * FROM upload_chunks WHERE session_id = $1 ORDER BY file_id, chunk_index', [sessionId]);
}

export async function getUploadChunk(sessionId: string, fileId: string, chunkIndex: number): Promise<UploadChunkRow | undefined> {
  return queryOne<UploadChunkRow>(`
    SELECT * FROM upload_chunks
    WHERE session_id = $1 AND file_id = $2 AND chunk_index = $3
  `, [sessionId, fileId, chunkIndex]);
}

export async function recordUploadChunk(params: {
  sessionId: string;
  fileId: string;
  chunkIndex: number;
  size: number;
  sha256?: string | null;
}): Promise<void> {
  await transaction(async (client) => {
    const db = withClient(client);
    await db.execute(`
      INSERT INTO upload_chunks (session_id, file_id, chunk_index, size, sha256)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (session_id, file_id, chunk_index) DO UPDATE
      SET size = EXCLUDED.size, sha256 = EXCLUDED.sha256
    `, [params.sessionId, params.fileId, params.chunkIndex, params.size, params.sha256 ?? null]);

    await db.execute(`
      UPDATE upload_sessions
      SET status = CASE WHEN status = 'created' THEN 'uploading' ELSE status END,
          uploaded_bytes = (
            SELECT COALESCE(SUM(size), 0) FROM upload_chunks WHERE session_id = $1
          ),
          updated_at = now()
      WHERE id = $1
    `, [params.sessionId]);

    await db.execute(`
      UPDATE upload_session_files
      SET status = 'uploading', updated_at = now()
      WHERE session_id = $1 AND id = $2 AND status = 'pending'
    `, [params.sessionId, params.fileId]);
  });
}

export async function updateSessionStatus(sessionId: string, status: UploadSessionRow['status'], error?: string | null): Promise<void> {
  await query('UPDATE upload_sessions SET status = $2, error = $3, updated_at = now() WHERE id = $1', [sessionId, status, error ?? null]);
}

export async function markFileCompleted(sessionId: string, fileId: string): Promise<void> {
  await query('UPDATE upload_session_files SET status = $3, updated_at = now() WHERE session_id = $1 AND id = $2', [sessionId, fileId, 'completed']);
}

export async function activeReservedBytes(projectId: string): Promise<number> {
  const row = await queryOne<{ bytes: string }>(`
    SELECT COALESCE(SUM(total_bytes), 0)::text AS bytes
    FROM upload_sessions
    WHERE project_id = $1 AND status IN ('created', 'uploading', 'failed') AND expires_at > now()
  `, [projectId]);
  return Number(row?.bytes ?? 0);
}
