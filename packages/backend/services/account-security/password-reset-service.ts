import { config } from '../../config.js';
import { queryOne, transaction } from '../../db/pg-repo.js';
import { hashPassword, invalidateAuthCache } from '../auth/auth.js';
import { normalizeAccountEmail } from './email-normalization.js';
import { createOpaqueAccountToken, hashAccountSecret } from './secrets.js';
import { getAccountMailProvider } from './mail/mail-service.js';
import { composeAccountMail } from './mail/account-mail-template.js';

const TTL_MS = 30 * 60 * 1000;
const ELIGIBLE_ROLES = ['admin', 'operator', 'member', 'guest', 'viewer'];
const origin = () => config.publicUrl || 'http://localhost:32354';
const digest = (token: string) => hashAccountSecret(token, process.env.TOWER_ACCOUNT_SECURITY_PEPPER || config.jwtSecret);
export class PasswordResetInvalidError extends Error { constructor() { super('This reset link is invalid or expired. Request a new one.'); } }

/** Always return the same public result. All supported roles are eligible; unverified or inactive identities cannot receive a link. */
export async function requestPasswordReset(input: { email: string; ip: string | null; targetUserId?: number; actorUserId?: number }): Promise<'accepted' | 'unavailable' | 'delivery_failed'> {
  let normalized: string;
  try { normalized = normalizeAccountEmail(input.email).normalized; } catch { return 'unavailable'; }
  const token = createOpaqueAccountToken();
  const tokenHash = digest(token);
  const issued = await transaction(async client => {
    // Serialize same-IP requests including unknown addresses, without storing requested addresses.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`password-reset:${input.ip || 'unknown'}`]);
    const ipCount = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM account_password_reset_requests WHERE request_ip IS NOT DISTINCT FROM $1 AND created_at > NOW()-INTERVAL '1 hour'", [input.ip]);
    if (Number(ipCount.rows[0].count) >= 10) return null;
    await client.query('INSERT INTO account_password_reset_requests(request_ip) VALUES ($1)', [input.ip]);
    const matches = await client.query<{ id: number }>(
      `SELECT u.id FROM users u JOIN account_email_identities e ON e.id=u.primary_email_identity_id AND e.user_id=u.id
       WHERE e.email_normalized=$1 AND e.state='verified' AND u.disabled=0 AND u.approval_status='active' AND u.role=ANY($2::text[])`,
      [normalized, ELIGIBLE_ROLES]);
    if (matches.rows.length !== 1) return null;
    const userId = matches.rows[0].id;
    if (input.targetUserId !== undefined && userId !== input.targetUserId) return null;
    const user = await client.query<{ id: number; email: string; auth_epoch: number; identity_id: number }>(
      `SELECT u.id,e.email,u.auth_epoch,e.id AS identity_id FROM users u JOIN account_email_identities e ON e.id=u.primary_email_identity_id AND e.user_id=u.id
       WHERE u.id=$1 AND e.email_normalized=$2 AND e.state='verified' AND u.disabled=0 AND u.approval_status='active' AND u.role=ANY($3::text[]) FOR UPDATE OF u`,
      [userId, normalized, ELIGIBLE_ROLES]);
    if (user.rows.length !== 1) return null;
    const identity = await client.query<{ email: string; state: string }>(
      'SELECT email,state FROM account_email_identities WHERE id=$1 AND user_id=$2 FOR UPDATE', [user.rows[0].identity_id, userId]);
    if (identity.rows.length !== 1 || identity.rows[0].state !== 'verified') return null;
    const accountCount = await client.query<{ count: string; latest: Date | null }>(
      "SELECT COUNT(*)::text AS count,MAX(created_at) AS latest FROM account_password_reset_challenges WHERE user_id=$1 AND created_at>NOW()-INTERVAL '1 hour'", [userId]);
    const { count, latest } = accountCount.rows[0];
    if (Number(count) >= 3 || (latest && Date.now() - new Date(latest).getTime() < 60_000)) return null;
    // A new independent link does not invalidate a link already in a user's inbox.
    // The account cooldown and hourly quota bound accidental duplicate delivery.
    const row = await client.query<{ id: string }>(
      `INSERT INTO account_password_reset_challenges(user_id,email_identity_id,auth_epoch,token_hash,expires_at,request_ip)
       SELECT u.id,u.primary_email_identity_id,u.auth_epoch,$2,$3,$4 FROM users u WHERE u.id=$1 RETURNING id`,
      [userId, tokenHash, new Date(Date.now()+TTL_MS), input.ip]);
    if (input.actorUserId !== undefined) await client.query("INSERT INTO account_security_events(actor_user_id,target_user_id,event_type,result) VALUES($1,$2,'admin_password_reset_requested','success')",[input.actorUserId,userId]);
    return { id: row.rows[0].id, email: identity.rows[0].email };
  });
  if (!issued) return 'unavailable';
  // Detached delivery keeps provider latency outside the HTTP response. A failed send
  // marks the capability unusable; provider error details are never logged.
  const deliver = async (): Promise<'accepted' | 'unavailable' | 'delivery_failed'> => {
      try {
        // Recheck eligibility immediately before delivery. A change after this check
        // but before the provider accepts mail is bounded by provider latency.
        const eligible = await queryOne<{ id: string }>(
          `SELECT c.id FROM account_password_reset_challenges c JOIN users u ON u.id=c.user_id
           JOIN account_email_identities e ON e.id=c.email_identity_id AND e.id=u.primary_email_identity_id AND e.user_id=u.id
           WHERE c.id=$1 AND c.status='pending' AND c.expires_at>NOW() AND c.auth_epoch=u.auth_epoch
             AND u.disabled=0 AND u.approval_status='active' AND u.role=ANY($2::text[]) AND e.state='verified'`,
          [issued.id, ELIGIBLE_ROLES]);
        if (!eligible) return 'unavailable';
        const sent = await getAccountMailProvider().send({
          ...composeAccountMail({version:1,kind:'password_reset',origin:origin(),token},issued.email,`password-reset:${issued.id}`,process.env.NODE_ENV === 'test'),
        });
        await transaction(async client => {
          await client.query('UPDATE account_password_reset_challenges SET provider_message_id=$2 WHERE id=$1 AND status=$3', [issued.id, sent.providerMessageId, 'pending']);
        });
        return 'accepted';
      } catch {
        try { await transaction(async client => { await client.query("UPDATE account_password_reset_challenges SET status='delivery_failed' WHERE id=$1 AND status='pending'", [issued.id]); }); } catch { /* No token or provider details in logs. */ }
        return 'delivery_failed';
      }
  };
  if (input.actorUserId !== undefined) return deliver();
  setImmediate(() => { void deliver(); });
  return 'accepted';
}

/** Only the final POST consumes the capability; account + identity + challenge are rechecked under locks. */
export async function consumePasswordReset(input: { token: string; password: string }): Promise<{ userId: number }> {
  if (typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.token) ||
      typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 1024) throw new PasswordResetInvalidError();
  const tokenHash = digest(input.token);
  // Unknown and expired links cannot spend Argon2 work. The transaction below
  // rechecks every condition after hashing, including a concurrent consumption.
  const candidate = await queryOne<{ id: string }>(
    "SELECT id FROM account_password_reset_challenges WHERE token_hash=$1 AND status='pending' AND expires_at>NOW()", [tokenHash]);
  if (!candidate) throw new PasswordResetInvalidError();
  const passwordHash = await hashPassword(input.password);
  const result = await transaction(async client => {
    const hint = await client.query<{ user_id: number }>("SELECT user_id FROM account_password_reset_challenges WHERE token_hash=$1 AND status='pending' AND expires_at>NOW()", [tokenHash]);
    if (hint.rows.length !== 1) return null;
    const user = await client.query<{ id: number; primary_email_identity_id: number; auth_epoch: number }>(
      "SELECT id,primary_email_identity_id,auth_epoch FROM users WHERE id=$1 AND disabled=0 AND approval_status='active' AND role=ANY($2::text[]) FOR UPDATE", [hint.rows[0].user_id, ELIGIBLE_ROLES]);
    if (user.rows.length !== 1) return null;
    // Keep the identity stable too, using the same user -> identity -> challenge order as email verification.
    await client.query('SELECT id FROM account_email_identities WHERE id=$1 FOR UPDATE', [user.rows[0].primary_email_identity_id]);
    const challenge = await client.query<{ id: string; email_identity_id: number; email: string; auth_epoch: number }>(
      `SELECT c.id,c.email_identity_id,c.auth_epoch,e.email FROM account_password_reset_challenges c
       JOIN account_email_identities e ON e.id=c.email_identity_id AND e.user_id=c.user_id AND e.state='verified'
       WHERE c.token_hash=$1 AND c.user_id=$2 AND c.status='pending' AND c.expires_at>NOW() FOR UPDATE OF c`, [tokenHash, user.rows[0].id]);
    if (challenge.rows.length !== 1 || Number(challenge.rows[0].email_identity_id) !== Number(user.rows[0].primary_email_identity_id)
        || Number(challenge.rows[0].auth_epoch) !== Number(user.rows[0].auth_epoch)) return null;
    await client.query('UPDATE users SET password_hash=$2,password_changed_at=NOW(),auth_epoch=auth_epoch+1 WHERE id=$1', [user.rows[0].id, passwordHash]);
    await client.query("UPDATE account_password_reset_challenges SET status='consumed',consumed_at=NOW() WHERE id=$1", [challenge.rows[0].id]);
    await client.query("UPDATE account_password_reset_challenges SET status='cancelled' WHERE user_id=$1 AND status='pending'", [user.rows[0].id]);
    await client.query("UPDATE auth_login_otp_challenges SET status='cancelled' WHERE user_id=$1 AND status='pending'", [user.rows[0].id]);
    await client.query("UPDATE auth_login_email_enrollments SET status='cancelled' WHERE user_id=$1 AND status='pending'", [user.rows[0].id]);
    await client.query("INSERT INTO account_security_events(target_user_id,event_type,result) VALUES($1,'password_self_reset','success')", [user.rows[0].id]);
    return { userId: user.rows[0].id, email: challenge.rows[0].email };
  });
  if (!result) throw new PasswordResetInvalidError();
  invalidateAuthCache(result.userId);
  // Detached notification cannot delay session/socket revocation or roll back a completed change.
  setImmediate(() => { void (async () => {
    try {
      await getAccountMailProvider().send({ ...composeAccountMail({version:1,kind:'password_changed_notice'},result.email,`password-changed:${tokenHash}`) });
    } catch {
      try { await transaction(async client => { await client.query("INSERT INTO account_security_events(target_user_id,event_type,result) VALUES($1,'password_changed_notice_delivery_failed','failure')",[result.userId]); }); } catch { /* No private data in logs. */ }
    }
  })(); });
  return { userId: result.userId };
}
