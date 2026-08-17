/**
 * Owns: conservative archival of abandoned, completely empty sidebar sessions.
 * Public API: archiveExpiredEmptySessions(), startEmptySessionCleanup(), stopEmptySessionCleanup().
 * See README.md.
 */

import { execute } from '../../db/pg-repo.js';

const EMPTY_SESSION_MAX_AGE_HOURS = 24;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 10 * 1000;

let cleanupTimer: NodeJS.Timeout | null = null;

/**
 * Hide only clearly untouched, auto-created sessions older than 24 hours.
 *
 * Safety contract:
 * - Archive instead of deleting, so History can restore false positives.
 * - Preserve renamed/favorited/tagged sessions and every session with conversation,
 *   engine, file, attachment, sharing, child-session, or agent-worker evidence.
 * - Preserve rooms, AI panel threads, automation/editor sessions, and other
 *   classified session types; only ungrouped/default sidebar sessions qualify.
 *   Legacy default labels (`temp`, `미분류`) are treated as ungrouped.
 */
export async function archiveExpiredEmptySessions(): Promise<number> {
  const result = await execute(
    `UPDATE sessions s
        SET archived = 1,
            updated_at = now()
      WHERE (s.archived IS NULL OR s.archived = 0)
        AND s.created_at < now() - ($1 * interval '1 hour')
        AND s.updated_at < now() - ($1 * interval '1 hour')
        AND s.room_id IS NULL
        AND s.parent_session_id IS NULL
        AND s.source_message_id IS NULL
        AND (s.label IS NULL OR s.label IN ('temp', '미분류'))
        AND COALESCE(s.kind, 'user') = 'user'
        AND COALESCE(s.auto_named, 1) = 1
        AND COALESCE(s.favorite, 0) = 0
        AND COALESCE(s.turn_count, 0) = 0
        AND COALESCE(s.total_tokens, 0) = 0
        AND COALESCE(s.total_cost, 0) = 0
        AND s.claude_session_id IS NULL
        AND s.pi_session_file IS NULL
        AND s.summary IS NULL
        AND COALESCE(s.tags, '[]') = '[]'
        AND COALESCE(s.files_edited, '[]') = '[]'
        AND NOT EXISTS (
          SELECT 1 FROM messages m WHERE m.session_id = s.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM sessions child WHERE child.parent_session_id = s.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM agent_workers aw
           WHERE aw.backing_session_id = s.id OR aw.parent_session_id = s.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM session_file_edits sfe WHERE sfe.session_id = s.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM session_attachments sa WHERE sa.session_id = s.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM session_shares ss WHERE ss.session_id = s.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM spawn_callbacks sc
           WHERE sc.spawned_session_id = s.id OR sc.parent_session_id = s.id
        )`,
    [EMPTY_SESSION_MAX_AGE_HOURS],
  );

  return result.changes;
}

async function runCleanup(): Promise<void> {
  try {
    const archived = await archiveExpiredEmptySessions();
    if (archived > 0) console.log(`[sessions] archived ${archived} abandoned empty session(s)`);
  } catch (err) {
    console.warn('[sessions] empty-session cleanup failed:', err);
  }
}

/** Start one process-local cleanup loop. The first pass is delayed so boot is not blocked. */
export function startEmptySessionCleanup(): void {
  if (cleanupTimer) return;

  cleanupTimer = setTimeout(() => {
    void runCleanup();
    cleanupTimer = setInterval(() => void runCleanup(), CLEANUP_INTERVAL_MS);
    cleanupTimer.unref?.();
  }, STARTUP_DELAY_MS);
  cleanupTimer.unref?.();
}

/** Stop the cleanup loop during graceful backend shutdown or tests. */
export function stopEmptySessionCleanup(): void {
  if (!cleanupTimer) return;
  clearTimeout(cleanupTimer);
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}
