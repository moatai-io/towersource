/**
 * Owns: registry metadata for files uploaded directly to a channel.
 * Public API: list/add/remove channel shared-file records. See README.md.
 */
import { execute, query, queryOne } from '../../db/pg-repo.js';

export interface ChannelSharedFile {
  id: string;
  channelId: string;
  storagePath: string;
  originalName: string;
  mimeType: string | null;
  sizeBytes: number;
  uploadedBy: number | null;
  uploadedByName: string | null;
  createdAt: string;
}

function fromRow(row: any): ChannelSharedFile {
  return {
    id: row.id,
    channelId: row.channel_id,
    storagePath: row.storage_path,
    originalName: row.original_name,
    mimeType: row.mime_type ?? null,
    sizeBytes: Number(row.size_bytes) || 0,
    uploadedBy: row.uploaded_by ?? null,
    uploadedByName: row.uploaded_by_name ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

/** Resolve one active channel file record; callers still enforce current channel membership. */
export async function getChannelSharedFile(channelId: string, fileId: string): Promise<ChannelSharedFile | null> {
  const row = await queryOne<any>(
    `SELECT csf.*, u.username AS uploaded_by_name
       FROM channel_shared_files csf
       LEFT JOIN users u ON u.id = csf.uploaded_by
      WHERE csf.channel_id = $1 AND csf.id = $2 AND csf.removed_at IS NULL`,
    [channelId, fileId],
  );
  return row ? fromRow(row) : null;
}

/** List active files shared with a channel. */
export async function listChannelSharedFiles(channelId: string): Promise<ChannelSharedFile[]> {
  const rows = await query<any>(
    `SELECT csf.*, u.username AS uploaded_by_name
       FROM channel_shared_files csf
       LEFT JOIN users u ON u.id = csf.uploaded_by
      WHERE csf.channel_id = $1 AND csf.removed_at IS NULL
      ORDER BY csf.created_at DESC`,
    [channelId],
  );
  return rows.map(fromRow);
}

/** Register a file after it is safely written inside the channel upload root. */
export async function addChannelSharedFile(input: {
  channelId: string;
  storagePath: string;
  originalName: string;
  mimeType?: string | null;
  sizeBytes: number;
  uploadedBy: number;
}): Promise<ChannelSharedFile> {
  const row = await queryOne<any>(
    `INSERT INTO channel_shared_files (
       channel_id, storage_path, original_name, mime_type, size_bytes, uploaded_by
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [input.channelId, input.storagePath, input.originalName, input.mimeType ?? null, input.sizeBytes, input.uploadedBy],
  );
  if (!row) throw new Error('Failed to register channel file');
  return fromRow(row);
}

/** Soft-remove a channel file share and return its storage path for physical cleanup. */
export async function removeChannelSharedFile(
  channelId: string,
  fileId: string,
  actor?: { userId: number; canManage: boolean },
): Promise<string | null> {
  const row = await queryOne<{ storage_path: string }>(
    `UPDATE channel_shared_files
        SET removed_at = NOW()
      WHERE id = $1
        AND channel_id = $2
        AND removed_at IS NULL
        AND ($3::boolean OR uploaded_by = $4)
      RETURNING storage_path`,
    [fileId, channelId, actor?.canManage ?? true, actor?.userId ?? 0],
  );
  return row?.storage_path ?? null;
}

/** Remove registry rows if physical persistence fails mid-request. */
export async function deleteChannelSharedFileRecord(fileId: string): Promise<void> {
  await execute('DELETE FROM channel_shared_files WHERE id = $1', [fileId]);
}
