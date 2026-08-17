import { query, queryOne, execute } from '../../db/pg-repo.js';
import { randomUUID } from 'crypto';
import { getMessages } from '../message-store.js';

export interface SessionShare {
  id: string;
  session_id: string;
  owner_id: number;
  share_type: 'internal' | 'external';
  target_user_id?: number;
  token?: string;
  expires_at?: string;
  revoked: number;
  snapshot_json?: string;
  created_at: string;
}

export interface SessionShareWithMeta extends SessionShare {
  owner_username?: string;
  target_username?: string;
  session_name?: string;
}

const EXPIRES_MAP: Record<string, number> = {
  '1h':  1 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d':  7 * 24 * 60 * 60 * 1000,
};

/** Create internal share (logged-in user to another logged-in user) */
export async function createInternalSessionShare(
  sessionId: string, ownerId: number, targetUserId: number,
): Promise<SessionShare> {
  const id = randomUUID();
  await execute(`
    INSERT INTO session_shares (id, session_id, owner_id, share_type, target_user_id)
    VALUES ($1, $2, $3, 'internal', $4)
  `, [id, sessionId, ownerId, targetUserId]);
  return await queryOne('SELECT * FROM session_shares WHERE id = $1', [id]) as SessionShare;
}

/** Create external share with a snapshot of current conversation */
export async function createExternalSessionShare(
  sessionId: string, ownerId: number, expiresIn: string,
): Promise<SessionShare & { token: string }> {
  const id = randomUUID();
  const token = randomUUID().replace(/-/g, '');
  const ms = EXPIRES_MAP[expiresIn] ?? EXPIRES_MAP['24h'];
  const expiresAt = new Date(Date.now() + ms).toISOString();

  // Snapshot: freeze the conversation at this point
  const messages = await getMessages(sessionId);
  // Strip internal fields, keep only what's needed for display
  const snapshot = messages.map((m: any) => ({
    role: m.role,
    content: m.content,
    username: m.username,
    created_at: m.created_at,
  }));
  const snapshotJson = JSON.stringify(snapshot);

  await execute(`
    INSERT INTO session_shares (id, session_id, owner_id, share_type, token, expires_at, snapshot_json)
    VALUES ($1, $2, $3, 'external', $4, $5, $6)
  `, [id, sessionId, ownerId, token, expiresAt, snapshotJson]);

  return await queryOne('SELECT * FROM session_shares WHERE id = $1', [id]) as SessionShare & { token: string };
}

/** Get all shares for a session (owner only) */
export async function getSharesBySession(sessionId: string, ownerId: number): Promise<SessionShareWithMeta[]> {
  return await query(`
    SELECT s.id, s.session_id, s.owner_id, s.share_type, s.target_user_id,
           s.token, s.expires_at, s.revoked, s.created_at,
           u.username as target_username
    FROM session_shares s
    LEFT JOIN users u ON s.target_user_id = u.id
    WHERE s.session_id = $1 AND s.owner_id = $2 AND s.revoked = 0
    ORDER BY s.created_at DESC
  `, [sessionId, ownerId]) as SessionShareWithMeta[];
}

/** Get shares shared WITH a user (internal only) */
export async function getSessionSharesWithMe(targetUserId: number): Promise<SessionShareWithMeta[]> {
  return await query(`
    SELECT s.id, s.session_id, s.owner_id, s.share_type, s.target_user_id,
           s.token, s.expires_at, s.revoked, s.created_at,
           u.username as owner_username, sess.name as session_name
    FROM session_shares s
    JOIN users u ON s.owner_id = u.id
    JOIN sessions sess ON s.session_id = sess.id
    WHERE s.target_user_id = $1 AND s.share_type = 'internal' AND s.revoked = 0
    ORDER BY s.created_at DESC
  `, [targetUserId]) as SessionShareWithMeta[];
}

/** Lookup by token (public access) */
export async function getSessionShareByToken(token: string): Promise<SessionShare | null> {
  return await queryOne('SELECT * FROM session_shares WHERE token = $1', [token]) as SessionShare | null;
}

/** Revoke a share */
export async function revokeSessionShare(shareId: string, ownerId: number): Promise<boolean> {
  const result = await execute(`
    UPDATE session_shares SET revoked = 1 WHERE id = $1 AND owner_id = $2
  `, [shareId, ownerId]);
  return result.changes > 0;
}

/** Validate token */
export function isSessionShareValid(share: SessionShare): boolean {
  if (share.revoked) return false;
  if (share.expires_at && new Date(share.expires_at) < new Date()) return false;
  return true;
}

/** Check if user has access to session via internal share */
export async function hasInternalShareAccess(sessionId: string, userId: number): Promise<boolean> {
  const result = await queryOne(`
    SELECT 1 FROM session_shares
    WHERE session_id = $1
      AND target_user_id = $2
      AND share_type = 'internal'
      AND revoked = 0
    LIMIT 1
  `, [sessionId, userId]);
  return !!result;
}
