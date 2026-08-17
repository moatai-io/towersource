import { query, queryOne, execute } from '../../db/pg-repo.js';
import { randomUUID } from 'crypto';

export interface Share {
  id: string;
  file_path: string;
  owner_id: number;
  share_type: 'internal' | 'external';
  target_user_id?: number;
  token?: string;
  expires_at?: string;
  revoked: number;
  created_at: string;
}

export interface ShareWithMeta extends Share {
  owner_username?: string;
  target_username?: string;
}

const EXPIRES_MAP: Record<string, number | null> = {
  '1h':      1 * 60 * 60 * 1000,
  '24h':     24 * 60 * 60 * 1000,
  '7d':      7 * 24 * 60 * 60 * 1000,
  '3mo':     90 * 24 * 60 * 60 * 1000,
  unlimited: null,
};

export async function createInternalShare(filePath: string, ownerId: number, targetUserId: number): Promise<Share> {
  const id = randomUUID();
  await execute(`
    INSERT INTO shares (id, file_path, owner_id, share_type, target_user_id)
    VALUES ($1, $2, $3, 'internal', $4)
  `, [id, filePath, ownerId, targetUserId]);
  return await queryOne('SELECT * FROM shares WHERE id = $1', [id]) as Share;
}

export async function createExternalShare(filePath: string, ownerId: number, expiresIn: string): Promise<Share & { token: string }> {
  const id = randomUUID();
  const token = randomUUID().replace(/-/g, '');
  const ms = Object.prototype.hasOwnProperty.call(EXPIRES_MAP, expiresIn)
    ? EXPIRES_MAP[expiresIn]
    : EXPIRES_MAP['24h'];
  const expiresAt = ms === null ? null : new Date(Date.now() + ms).toISOString();
  await execute(`
    INSERT INTO shares (id, file_path, owner_id, share_type, token, expires_at)
    VALUES ($1, $2, $3, 'external', $4, $5)
  `, [id, filePath, ownerId, token, expiresAt]);
  return await queryOne('SELECT * FROM shares WHERE id = $1', [id]) as Share & { token: string };
}

export async function getSharesByFile(filePath: string, ownerId: number): Promise<ShareWithMeta[]> {
  return await query(`
    SELECT s.*, u.username as target_username
    FROM shares s
    LEFT JOIN users u ON s.target_user_id = u.id
    WHERE s.file_path = $1 AND s.owner_id = $2 AND s.revoked = 0
    ORDER BY s.created_at DESC
  `, [filePath, ownerId]) as ShareWithMeta[];
}

export async function getSharesWithMe(targetUserId: number): Promise<ShareWithMeta[]> {
  return await query(`
    SELECT s.*, u.username as owner_username
    FROM shares s
    JOIN users u ON s.owner_id = u.id
    WHERE s.target_user_id = $1 AND s.share_type = 'internal' AND s.revoked = 0
    ORDER BY s.created_at DESC
  `, [targetUserId]) as ShareWithMeta[];
}

export async function getExternalSharesByOwner(ownerId: number): Promise<ShareWithMeta[]> {
  return await query(`
    SELECT s.*, u.username as owner_username
    FROM shares s
    JOIN users u ON s.owner_id = u.id
    WHERE s.owner_id = $1 AND s.share_type = 'external' AND s.revoked = 0
    ORDER BY s.created_at DESC
  `, [ownerId]) as ShareWithMeta[];
}

export async function getShareByToken(token: string): Promise<Share | null> {
  return await queryOne('SELECT * FROM shares WHERE token = $1', [token]) as Share | null;
}

export async function revokeShare(shareId: string, ownerId: number): Promise<boolean> {
  const result = await execute(`
    UPDATE shares SET revoked = 1 WHERE id = $1 AND owner_id = $2 AND share_type = 'external'
  `, [shareId, ownerId]);
  return result.changes > 0;
}

export async function hasInternalShareForUser(filePath: string, userId: number): Promise<boolean> {
  const row = await queryOne(`
    SELECT 1 FROM shares
    WHERE file_path = $1 AND target_user_id = $2 AND share_type = 'internal' AND revoked = 0
    LIMIT 1
  `, [filePath, userId]);
  return !!row;
}

export function isTokenValid(share: Share): boolean {
  if (share.revoked) return false;
  if (share.expires_at && new Date(share.expires_at) < new Date()) return false;
  return true;
}
