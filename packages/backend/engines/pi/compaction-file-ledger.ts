// Owns Tower-side file-ledger checkpoints that survive Pi compaction.
// Public API: appendTowerFileLedgerCheckpoint.

import { query } from '../../db/pg-repo.js';

const CHECKPOINT_CUSTOM_TYPE = 'tower-file-ledger';
const DEFAULT_FILE_LIMIT = 120;
const MAX_PATH_CHARS = 400;

type SessionManagerLike = {
  appendCustomMessageEntry?: (
    customType: string,
    content: string | Array<{ type: 'text'; text: string }>,
    display: boolean,
    details?: unknown,
  ) => string;
};

type FileLedgerRow = {
  file_path: string;
  tool_name: string | null;
  touched_at: string;
};

export type TowerFileLedgerCheckpointResult = {
  appended: boolean;
  entryId?: string;
  fileCount: number;
  omittedCount: number;
  reason?: string;
};

function normalizePathForCheckpoint(filePath: string): string {
  const oneLine = String(filePath || '').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= MAX_PATH_CHARS) return oneLine;
  return `${oneLine.slice(0, Math.floor(MAX_PATH_CHARS * 0.6))}…${oneLine.slice(-Math.floor(MAX_PATH_CHARS * 0.35))}`;
}

async function loadSessionFileLedger(sessionId: string, limit: number): Promise<{ rows: FileLedgerRow[]; total: number }> {
  const totalRow = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM session_file_edits
      WHERE session_id = $1`,
    [sessionId],
  );
  const total = Number(totalRow[0]?.count || 0);
  if (total <= 0) return { rows: [], total: 0 };

  const rows = await query<FileLedgerRow>(
    `SELECT file_path, tool_name, created_at::text AS touched_at
       FROM session_file_edits
      WHERE session_id = $1
      ORDER BY created_at ASC, file_path ASC
      LIMIT $2`,
    [sessionId, Math.max(1, Math.min(500, Math.floor(limit) || DEFAULT_FILE_LIMIT))],
  );
  return { rows, total };
}

function formatCheckpoint(params: {
  rows: FileLedgerRow[];
  total: number;
  limit: number;
  reason: string;
}): string {
  const { rows, total, limit, reason } = params;
  const omitted = Math.max(0, total - rows.length);
  const fileLines = rows.map((row) => {
    const tool = row.tool_name ? ` (${row.tool_name})` : '';
    return `- ${normalizePathForCheckpoint(row.file_path)}${tool}`;
  });

  return [
    '## Tower Durable File Ledger',
    '',
    'This checkpoint was inserted by Tower after Pi context compaction. Treat this list as the authoritative per-session file ledger recorded outside the compacted transcript. It may include files edited many turns before the latest compaction.',
    '',
    `Reason: ${reason}`,
    `Recorded files: ${total}${omitted > 0 ? ` (showing ${rows.length}, omitted ${omitted} beyond limit ${limit})` : ''}`,
    '',
    '### Files touched or created in this Tower session',
    fileLines.length > 0 ? fileLines.join('\n') : '- (none)',
    '',
    '### Continuation rule',
    '- Before assuming a file was untouched or deciding what to inspect next, use this ledger together with the latest user request and recent visible messages.',
  ].join('\n');
}

/**
 * Append a hidden custom_message after a successful Pi compaction so the next
 * LLM context sees Tower's DB-backed file ledger even if the compacted transcript
 * omitted old tool calls. Best-effort: never fail the user's run.
 */
export async function appendTowerFileLedgerCheckpoint(params: {
  sessionId: string;
  session: SessionManagerLike | null | undefined;
  reason: string;
  limit?: number;
}): Promise<TowerFileLedgerCheckpointResult> {
  const { sessionId, session, reason } = params;
  const limit = Math.max(1, Math.min(500, Math.floor(params.limit || DEFAULT_FILE_LIMIT)));
  if (!sessionId) return { appended: false, fileCount: 0, omittedCount: 0, reason: 'missing sessionId' };
  if (!session?.appendCustomMessageEntry) return { appended: false, fileCount: 0, omittedCount: 0, reason: 'session manager cannot append custom_message' };

  try {
    const { rows, total } = await loadSessionFileLedger(sessionId, limit);
    if (total <= 0) return { appended: false, fileCount: 0, omittedCount: 0, reason: 'no file ledger rows' };
    const content = formatCheckpoint({ rows, total, limit, reason });
    const entryId = session.appendCustomMessageEntry(
      CHECKPOINT_CUSTOM_TYPE,
      content,
      false,
      {
        source: 'session_file_edits',
        fileCount: total,
        omittedCount: Math.max(0, total - rows.length),
        reason,
        insertedAt: new Date().toISOString(),
      },
    );
    return { appended: true, entryId, fileCount: total, omittedCount: Math.max(0, total - rows.length) };
  } catch (err: any) {
    return { appended: false, fileCount: 0, omittedCount: 0, reason: err?.message || String(err) };
  }
}
