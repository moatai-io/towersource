/**
 * Owns per-user Latest/Inbox attention state.
 * Public API: getUserSessionAttention(), upsertUserSessionAttention().
 * See migration 103_user_session_attention.sql.
 */
import { execute, query } from '../../db/pg-repo.js';

export type SessionAttentionState = 'unread' | 'recently_read' | 'dismissed';

export interface SessionAttentionRow {
  sessionId: string;
  sessionUpdatedAt: string | null;
  state: SessionAttentionState;
  updatedAt: string;
}

export async function getUserSessionAttention(userId: number): Promise<SessionAttentionRow[]> {
  const rows = await query<any>(
    `SELECT session_id, session_updated_at, state, updated_at
       FROM user_session_attention
      WHERE user_id = $1
      ORDER BY updated_at DESC
      LIMIT 2000`,
    [userId],
  );
  return rows.map((row) => ({
    sessionId: row.session_id,
    sessionUpdatedAt: row.session_updated_at || null,
    state: row.state,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  }));
}

export async function upsertUserSessionAttention(
  userId: number,
  entries: Array<{ sessionId: string; sessionUpdatedAt?: string | null; state: SessionAttentionState }>,
): Promise<void> {
  const normalized = entries
    .filter((entry) => entry.sessionId && ['unread', 'recently_read', 'dismissed'].includes(entry.state))
    .slice(0, 2000);
  if (normalized.length === 0) return;

  for (const entry of normalized) {
    await execute(
      `INSERT INTO user_session_attention (user_id, session_id, session_updated_at, state, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, session_id, state)
       DO UPDATE SET session_updated_at = EXCLUDED.session_updated_at,
                     updated_at = NOW()`,
      [userId, entry.sessionId, entry.sessionUpdatedAt || null, entry.state],
    );
  }
}

export async function deleteUserSessionAttention(
  userId: number,
  entries: Array<{ sessionId: string; state?: SessionAttentionState }>,
): Promise<void> {
  const normalized = entries.filter((entry) => entry.sessionId).slice(0, 2000);
  if (normalized.length === 0) return;

  for (const entry of normalized) {
    if (entry.state) {
      await execute(
        `DELETE FROM user_session_attention WHERE user_id = $1 AND session_id = $2 AND state = $3`,
        [userId, entry.sessionId, entry.state],
      );
    } else {
      await execute(
        `DELETE FROM user_session_attention WHERE user_id = $1 AND session_id = $2`,
        [userId, entry.sessionId],
      );
    }
  }
}
