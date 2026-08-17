/**
 * Owns: operational freshness and coverage diagnostics for canonical Work Ledger writes.
 * Public API: getWorkLedgerHealth(). See README.md.
 */
import { queryOne } from '../../db/pg-repo.js';

export interface WorkLedgerHealth {
  checkedAt: string;
  windowHours: number;
  status: 'healthy' | 'degraded' | 'idle';
  latestTodoWriteMessageAt: string | null;
  latestCanonicalTodoWriteAt: string | null;
  freshnessLagMinutes: number | null;
  todoWriteMessages: number;
  metadataSnapshots: number;
  completedSnapshots: number;
  completedSnapshotRate: number | null;
  canonicalTodoWriteRecords: number;
  fallbackOnlyEstimate: number;
  reasons: string[];
}

interface HealthRow {
  latest_todowrite_message_at: Date | null;
  latest_canonical_todowrite_at: Date | null;
  todowrite_messages: string | number;
  metadata_snapshots: string | number;
  completed_snapshots: string | number;
  canonical_todowrite_records: string | number;
}

/** Return a cheap aggregate suitable for admin health checks and alerting. */
export async function getWorkLedgerHealth(windowHours = 24): Promise<WorkLedgerHealth> {
  const safeWindowHours = Math.min(Math.max(Math.trunc(windowHours) || 24, 1), 24 * 30);
  const row = await queryOne<HealthRow>(`
    WITH recent_messages AS (
      SELECT created_at, content
      FROM messages
      WHERE role = 'assistant'
        AND content LIKE '%TodoWrite%'
        AND created_at >= NOW() - ($1::text || ' hours')::interval
    ), todo_stats AS (
      SELECT
        MAX(created_at) AS latest_todowrite_message_at,
        COUNT(*) AS todowrite_messages,
        COUNT(*) FILTER (WHERE content LIKE '%"work"%') AS metadata_snapshots,
        COUNT(*) FILTER (
          WHERE content LIKE '%"work"%'
            AND content NOT LIKE '%"status":"pending"%'
            AND content NOT LIKE '%"status":"in_progress"%'
        ) AS completed_snapshots
      FROM recent_messages
    ), ledger_stats AS (
      SELECT
        MAX(updated_at) AS latest_canonical_todowrite_at,
        COUNT(*) FILTER (WHERE updated_at >= NOW() - ($1::text || ' hours')::interval) AS canonical_todowrite_records
      FROM work_ledger_records
      WHERE source_type = 'todowrite'
    )
    SELECT * FROM todo_stats CROSS JOIN ledger_stats
  `, [safeWindowHours]);

  const checkedAt = new Date();
  const latestMessage = row?.latest_todowrite_message_at ? new Date(row.latest_todowrite_message_at) : null;
  const latestCanonical = row?.latest_canonical_todowrite_at ? new Date(row.latest_canonical_todowrite_at) : null;
  const todoWriteMessages = Number(row?.todowrite_messages || 0);
  const metadataSnapshots = Number(row?.metadata_snapshots || 0);
  const completedSnapshots = Number(row?.completed_snapshots || 0);
  const canonicalTodoWriteRecords = Number(row?.canonical_todowrite_records || 0);
  const freshnessLagMinutes = latestMessage && latestCanonical
    ? Math.max(0, Math.round((latestMessage.getTime() - latestCanonical.getTime()) / 60_000))
    : latestMessage ? null : 0;
  const reasons: string[] = [];

  if (metadataSnapshots > 0 && canonicalTodoWriteRecords === 0) reasons.push('recent_metadata_without_canonical_records');
  if (latestMessage && (!latestCanonical || latestMessage.getTime() - latestCanonical.getTime() > 30 * 60_000)) reasons.push('canonical_write_lag_over_30m');
  if (metadataSnapshots >= 5 && completedSnapshots / metadataSnapshots < 0.5) reasons.push('completed_snapshot_rate_below_50pct');

  return {
    checkedAt: checkedAt.toISOString(),
    windowHours: safeWindowHours,
    status: todoWriteMessages === 0 ? 'idle' : reasons.length > 0 ? 'degraded' : 'healthy',
    latestTodoWriteMessageAt: latestMessage?.toISOString() || null,
    latestCanonicalTodoWriteAt: latestCanonical?.toISOString() || null,
    freshnessLagMinutes,
    todoWriteMessages,
    metadataSnapshots,
    completedSnapshots,
    completedSnapshotRate: metadataSnapshots > 0 ? completedSnapshots / metadataSnapshots : null,
    canonicalTodoWriteRecords,
    fallbackOnlyEstimate: Math.max(0, metadataSnapshots - canonicalTodoWriteRecords),
    reasons,
  };
}
