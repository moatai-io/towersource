import { query, queryOne, execute } from '../../db/pg-repo.js';
import type { CheckpointFileChange, FileSnapshot } from './file-checkpoint.js';

interface StoredChangeRow {
  file_path: string;
  before_exists: boolean;
  before_sha256: string | null;
  before_content: Buffer | null;
  after_exists: boolean;
  after_sha256: string | null;
  after_content: Buffer | null;
}

export async function getTurnCheckpoint(params: { rootTurnId: string; sessionId: string }): Promise<{ id: string; coverage: 'tool_edits' | 'partial'; createdAt: string } | null> {
  const row = await queryOne<{ id: string; coverage: 'tool_edits' | 'partial'; created_at: string }>(
    `SELECT id, coverage, created_at::text
       FROM turn_checkpoints
      WHERE root_turn_id = $1 AND session_id = $2`,
    [params.rootTurnId, params.sessionId],
  );
  return row ? { id: row.id, coverage: row.coverage, createdAt: row.created_at } : null;
}

export async function getCheckpointOwner(checkpointId: string): Promise<{ sessionId: string; rootTurnId: string; coverage: 'tool_edits' | 'partial' } | null> {
  const row = await queryOne<{ session_id: string; root_turn_id: string; coverage: 'tool_edits' | 'partial' }>(
    `SELECT session_id, root_turn_id, coverage FROM turn_checkpoints WHERE id = $1`, [checkpointId],
  );
  return row ? { sessionId: row.session_id, rootTurnId: row.root_turn_id, coverage: row.coverage } : null;
}

export async function ensureTurnCheckpoint(params: {
  rootTurnId: string;
  sessionId: string;
  partial?: boolean;
}): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO turn_checkpoints (root_turn_id, session_id, coverage)
     VALUES ($1, $2, $3)
     ON CONFLICT (root_turn_id) DO UPDATE
       SET coverage = CASE WHEN turn_checkpoints.coverage = 'partial' OR EXCLUDED.coverage = 'partial' THEN 'partial' ELSE 'tool_edits' END
     RETURNING id`,
    [params.rootTurnId, params.sessionId, params.partial ? 'partial' : 'tool_edits'],
  );
  if (!row) throw new Error('checkpoint_create_failed');
  return row.id;
}

/** First before wins; every successful edit refreshes the last after snapshot. */
export async function recordCheckpointFileChange(params: {
  checkpointId: string;
  filePath: string;
  toolName: string;
  before: FileSnapshot;
  after: FileSnapshot;
}): Promise<void> {
  await execute(
    `INSERT INTO checkpoint_file_changes
       (checkpoint_id, file_path, tool_name, before_exists, before_sha256, before_content,
        after_exists, after_sha256, after_content)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (checkpoint_id, file_path) DO UPDATE
       SET tool_name = EXCLUDED.tool_name,
           after_exists = EXCLUDED.after_exists,
           after_sha256 = EXCLUDED.after_sha256,
           after_content = EXCLUDED.after_content,
           updated_at = NOW()`,
    [params.checkpointId, params.filePath, params.toolName,
     params.before.exists, params.before.sha256, params.before.content,
     params.after.exists, params.after.sha256, params.after.content],
  );
}

export async function loadCheckpointFileChanges(checkpointId: string): Promise<CheckpointFileChange[]> {
  const rows = await query<StoredChangeRow>(
    `SELECT file_path, before_exists, before_sha256, before_content,
            after_exists, after_sha256, after_content
       FROM checkpoint_file_changes
      WHERE checkpoint_id = $1
      ORDER BY file_path`,
    [checkpointId],
  );
  return rows.map((row) => ({
    filePath: row.file_path,
    before: { exists: row.before_exists, sha256: row.before_sha256, content: row.before_content },
    after: { exists: row.after_exists, sha256: row.after_sha256, content: row.after_content },
  }));
}

export async function recordRestoreRun(params: {
  checkpointId: string;
  requestedBy: number;
  status: 'previewed' | 'applied' | 'conflict' | 'failed';
  previewHash: string;
  selectedPaths: string[];
  conflicts: unknown[];
  error?: string;
}): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO checkpoint_restore_runs
       (checkpoint_id, requested_by, status, preview_hash, selected_paths, conflicts, error, completed_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,CASE WHEN $3 = 'previewed' THEN NULL ELSE NOW() END)
     RETURNING id`,
    [params.checkpointId, params.requestedBy, params.status, params.previewHash,
     JSON.stringify(params.selectedPaths), JSON.stringify(params.conflicts), params.error ?? null],
  );
  if (!row) throw new Error('checkpoint_restore_audit_failed');
  return row.id;
}
