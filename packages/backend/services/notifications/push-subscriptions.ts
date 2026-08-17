/**
 * Owns: persistence for browser/PWA Web Push subscriptions.
 * Public API: upsertPushSubscription, listPushSubscriptions, disablePushSubscription.
 */

import { getPgPool } from '../../db/pg.js';

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string | null;
  deviceLabel?: string | null;
  platform?: string | null;
}

export interface StoredPushSubscription {
  id: string;
  userId: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  deviceLabel: string | null;
  platform: string | null;
  lastSeenAt: string;
  disabledAt: string | null;
  createdAt: string;
}

function mapRow(row: any): StoredPushSubscription {
  return {
    id: row.id,
    userId: row.user_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    userAgent: row.user_agent ?? null,
    deviceLabel: row.device_label ?? null,
    platform: row.platform ?? null,
    lastSeenAt: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : String(row.last_seen_at),
    disabledAt: row.disabled_at ? (row.disabled_at instanceof Date ? row.disabled_at.toISOString() : String(row.disabled_at)) : null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

export async function upsertPushSubscription(userId: number, input: PushSubscriptionInput): Promise<StoredPushSubscription> {
  const { rows } = await getPgPool().query(
    `INSERT INTO user_push_subscriptions
       (user_id, endpoint, p256dh, auth, user_agent, device_label, platform, last_seen_at, disabled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NULL)
     ON CONFLICT (endpoint) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth,
       user_agent = EXCLUDED.user_agent,
       device_label = EXCLUDED.device_label,
       platform = EXCLUDED.platform,
       last_seen_at = NOW(),
       disabled_at = NULL
     RETURNING *`,
    [
      userId,
      input.endpoint,
      input.keys.p256dh,
      input.keys.auth,
      input.userAgent ?? null,
      input.deviceLabel ?? null,
      input.platform ?? null,
    ],
  );
  return mapRow(rows[0]);
}

export async function listPushSubscriptions(userId: number, activeOnly = true): Promise<StoredPushSubscription[]> {
  const { rows } = await getPgPool().query(
    `SELECT * FROM user_push_subscriptions
     WHERE user_id = $1 ${activeOnly ? 'AND disabled_at IS NULL' : ''}
     ORDER BY last_seen_at DESC`,
    [userId],
  );
  return rows.map(mapRow);
}

export async function disablePushSubscriptionById(userId: number, id: string): Promise<boolean> {
  const { rowCount } = await getPgPool().query(
    `UPDATE user_push_subscriptions SET disabled_at = NOW()
     WHERE id = $1 AND user_id = $2 AND disabled_at IS NULL`,
    [id, userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function disablePushSubscriptionByEndpoint(userId: number, endpoint: string): Promise<boolean> {
  const { rowCount } = await getPgPool().query(
    `UPDATE user_push_subscriptions SET disabled_at = NOW()
     WHERE endpoint = $1 AND user_id = $2 AND disabled_at IS NULL`,
    [endpoint, userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function disablePushSubscriptionGlobal(id: string): Promise<void> {
  await getPgPool().query(
    `UPDATE user_push_subscriptions SET disabled_at = NOW() WHERE id = $1`,
    [id],
  );
}
