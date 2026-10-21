/**
 * Owns: conservative archival of stale persistent agent workers.
 * Public API: archiveStaleAgentWorkers(), startAgentWorkerCleanup(), stopAgentWorkerCleanup().
 */

import { execute } from '../db/pg-repo.js';

const STALE_WORKER_MAX_AGE_DAYS = 30;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 30 * 1000;

let cleanupTimer: NodeJS.Timeout | null = null;

/**
 * Archive inactive workers and hide their backing sessions without deleting data.
 *
 * Safety contract:
 * - Only idle/failed workers qualify; running, queued, paused, and archived workers do not.
 * - Both worker and backing session must have been untouched for the full retention period.
 * - Any queued/running agent run or pending spawn callback preserves the worker.
 * - Sessions, messages, files, run history, and JSONL files remain intact and recoverable.
 */
export async function archiveStaleAgentWorkers(): Promise<number> {
  const result = await execute(
    `WITH candidates AS (
       SELECT aw.id, aw.backing_session_id
         FROM agent_workers aw
         LEFT JOIN sessions s ON s.id = aw.backing_session_id
        WHERE aw.status IN ('idle', 'failed')
          AND aw.updated_at < now() - ($1 * interval '1 day')
          AND (s.id IS NULL OR s.updated_at < now() - ($1 * interval '1 day'))
          AND NOT EXISTS (
            SELECT 1 FROM agent_runs ar
             WHERE ar.worker_id = aw.id
               AND ar.status IN ('queued', 'running')
          )
          AND NOT EXISTS (
            SELECT 1 FROM spawn_callbacks sc
             WHERE sc.spawned_session_id = aw.backing_session_id
               AND sc.fired_at IS NULL
          )
     ),
     archived_workers AS (
       UPDATE agent_workers aw
          SET status = 'archived',
              updated_at = now(),
              last_heartbeat_at = now()
         FROM candidates c
        WHERE aw.id = c.id
        RETURNING aw.id, aw.owner_user_id, aw.project_id,
                  aw.parent_session_id, aw.backing_session_id
     ),
     archived_sessions AS (
       UPDATE sessions s
          SET archived = 1,
              archived_at = now()
         FROM archived_workers aw
        WHERE s.id = aw.backing_session_id
        RETURNING s.id
     )
     INSERT INTO agent_events
       (id, kind, worker_id, owner_user_id, project_id,
        parent_session_id, session_id, metadata)
     SELECT gen_random_uuid()::text, 'worker_auto_archived', aw.id,
            aw.owner_user_id, aw.project_id, aw.parent_session_id,
            aw.backing_session_id,
            jsonb_build_object(
              'reason', 'stale',
              'retentionDays', $1,
              'sessionArchived', aw.backing_session_id IS NOT NULL
            )
       FROM archived_workers aw`,
    [STALE_WORKER_MAX_AGE_DAYS],
  );

  return result.changes;
}

async function runCleanup(): Promise<void> {
  try {
    const archived = await archiveStaleAgentWorkers();
    if (archived > 0) console.log(`[agent-workers] auto-archived ${archived} stale worker(s)`);
  } catch (err) {
    console.warn('[agent-workers] stale-worker cleanup failed:', err);
  }
}

/** Start one process-local daily cleanup loop after a non-blocking startup delay. */
export function startAgentWorkerCleanup(): void {
  if (cleanupTimer) return;

  cleanupTimer = setTimeout(() => {
    void runCleanup();
    cleanupTimer = setInterval(() => void runCleanup(), CLEANUP_INTERVAL_MS);
    cleanupTimer.unref?.();
  }, STARTUP_DELAY_MS);
  cleanupTimer.unref?.();
}

/** Stop the cleanup loop during graceful backend shutdown or tests. */
export function stopAgentWorkerCleanup(): void {
  if (!cleanupTimer) return;
  clearTimeout(cleanupTimer);
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}
