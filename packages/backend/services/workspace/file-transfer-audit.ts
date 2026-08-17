import path from 'path';
import { execute, queryOne } from '../../db/pg-repo.js';

export type FileTransferDirection = 'upload' | 'download';
export type FileTransferKind = 'single' | 'selection' | 'folder' | 'multipart' | 'resumable';
export type FileTransferStatus = 'started' | 'completed' | 'failed' | 'denied';

async function resolveProjectId(paths: string[], explicitProjectId?: string | null): Promise<string | null> {
  if (explicitProjectId) return explicitProjectId;
  const resolved = paths.map((value) => path.resolve(value));
  if (!resolved.length) return null;
  const rows = await queryOne<{ id: string }>(`
    SELECT id FROM projects
    WHERE archived IS DISTINCT FROM 1
      AND ($1::text = root_path OR $1::text LIKE root_path || '/%')
    ORDER BY length(root_path) DESC
    LIMIT 1
  `, [resolved[0]]);
  return rows?.id || null;
}

function auditPaths(paths: string[]): string[] {
  return paths.slice(0, 100).map((value) => path.resolve(value));
}

export async function appendFileTransferEvent(input: {
  actorUserId?: number | null;
  projectId?: string | null;
  direction: FileTransferDirection;
  transferKind: FileTransferKind;
  status?: FileTransferStatus;
  paths: string[];
  itemCount?: number;
  totalBytes?: number | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const paths = auditPaths(input.paths);
  const projectId = await resolveProjectId(paths, input.projectId);
  await execute(`
    INSERT INTO file_transfer_events
      (project_id, actor_user_id, direction, transfer_kind, status, item_count, total_bytes, paths, metadata)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
  `, [
    projectId,
    input.actorUserId || null,
    input.direction,
    input.transferKind,
    input.status || 'completed',
    input.itemCount ?? input.paths.length,
    input.totalBytes ?? null,
    JSON.stringify(paths),
    JSON.stringify({ ...(input.metadata || {}), pathsTruncated: input.paths.length > paths.length }),
  ]);
}

export function appendFileTransferEventSafe(input: Parameters<typeof appendFileTransferEvent>[0]): void {
  void appendFileTransferEvent(input).catch((error) => {
    console.warn('[file-transfer-audit] failed:', error instanceof Error ? error.message : error);
  });
}
