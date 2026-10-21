import { transaction } from '../../db/pg-repo.js';
import { canManageUserRole } from '../authority/user-management-policy.js';
import { invalidateAuthCache } from './auth.js';

export type UserAccessResult = 'not_found' | 'forbidden';
export type ReactivationResult = UserAccessResult | 'ineligible' | 'reactivated';

/** Lock the target while checking role and restoring it; audit every outcome in the same transaction. */
export async function reactivateUser(input: { userId: number; actorUserId: number; actorRole: string }): Promise<ReactivationResult> {
  const result = await transaction(async client => {
    const target = (await client.query<{ role: string; disabled: number; approval_status: string }>(
      'SELECT role, disabled, approval_status FROM users WHERE id = $1 FOR UPDATE', [input.userId],
    )).rows[0];
    let outcome: ReactivationResult = !target ? 'not_found'
      : !canManageUserRole(input.actorRole, target.role) ? 'forbidden'
      : Number(target.disabled) !== 1 || target.approval_status !== 'active' ? 'ineligible' : 'reactivated';
    if (outcome === 'reactivated') {
      const updated = await client.query(
        "UPDATE users SET disabled = 0, auth_epoch = auth_epoch + 1 WHERE id = $1 AND disabled = 1 AND approval_status = 'active' RETURNING id", [input.userId],
      );
      if (!updated.rows[0]) outcome = 'ineligible';
    }
    await client.query(
      `INSERT INTO account_security_events (actor_user_id, target_user_id, event_type, result, metadata)
        VALUES ($1, $2, 'user_reactivation', $3, $4::jsonb)`,
      [input.actorUserId, target ? input.userId : null, outcome === 'reactivated' ? 'success' : outcome === 'forbidden' ? 'blocked' : 'failure',
        JSON.stringify({ outcome, ...(target ? {} : { requestedUserId: input.userId }) })],
    );
    return outcome;
  });
  if (result === 'reactivated') invalidateAuthCache(input.userId);
  return result;
}

/** Hold a shared target-row lock through the bounded read so an operator never sees a newly privileged account. */
export async function listUserAuthEvents(input: { userId: number; actorRole: string; before?: number }): Promise<UserAccessResult | Array<{ id: number; event_type: string; ip_address: string | null; created_at: string }>> {
  return transaction(async client => {
    const target = (await client.query<{ role: string }>('SELECT role FROM users WHERE id = $1 FOR SHARE', [input.userId])).rows[0];
    if (!target) return 'not_found';
    if (!canManageUserRole(input.actorRole, target.role)) return 'forbidden';
    const rows = await client.query<{ id: number; event_type: string; ip_address: string | null; created_at: string }>(
      `SELECT id, event_type, ip_address, created_at FROM auth_login_events
        WHERE user_id = $1 AND ($2::bigint IS NULL OR id < $2)
        ORDER BY id DESC LIMIT 20`, [input.userId, input.before ?? null],
    );
    return rows.rows;
  });
}
