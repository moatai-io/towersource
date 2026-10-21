import { config } from '../../config.js';
import { query, queryOne, transaction } from '../../db/pg-repo.js';
import { USERNAME_RE, InvalidUsernameError, UsernameTakenError, autoJoinDefaultProjects, hashPassword } from '../auth/auth.js';
import { normalizeAccountEmail, maskAccountEmail } from './email-normalization.js';
import { createOpaqueAccountToken, hashAccountSecret } from './secrets.js';
import { getAccountMailProvider } from './mail/mail-service.js';
import { composeAccountMail } from './mail/account-mail-template.js';

const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const EMAIL_ROLES = new Set(['viewer', 'guest', 'member', 'operator']);

export class AccountEmailConflictError extends Error { readonly code = 'ACCOUNT_EMAIL_CONFLICT'; }
export class AccountEmailNotFoundError extends Error { readonly code = 'ACCOUNT_EMAIL_NOT_FOUND'; }
export class AccountEmailStateError extends Error { readonly code = 'ACCOUNT_EMAIL_STATE'; }
export class AccountEmailDeliveryError extends Error { readonly code = 'ACCOUNT_EMAIL_DELIVERY'; }

interface InvitationRow {
  id: string; email: string; email_normalized: string; role: string;
  display_name: string | null; affiliation: string | null; token_hash: string;
  status: string; expires_at: string; created_by: number | null;
}

function pepper(): string {
  return process.env.TOWER_ACCOUNT_SECURITY_PEPPER || config.jwtSecret;
}

function publicOrigin(): string {
  return config.publicUrl || 'http://localhost:32354';
}

async function assertEmailAvailable(normalized: string, excludeUserId?: number): Promise<void> {
  const identity = await queryOne<{ user_id: number }>(
    `SELECT user_id FROM account_email_identities
      WHERE email_normalized = $1 AND state IN ('pending','verified')`, [normalized],
  );
  if (identity && identity.user_id !== excludeUserId) throw new AccountEmailConflictError('Email is already in use');
  const invitation = await queryOne<{ id: string }>(
    `SELECT id FROM account_email_invitations WHERE email_normalized = $1 AND status = 'pending' AND expires_at > NOW()`, [normalized],
  );
  if (invitation) throw new AccountEmailConflictError('Email already has a pending invitation');
}

async function audit(input: { actorUserId?: number | null; targetUserId?: number | null; eventType: string; result: 'success'|'failure'|'blocked'; metadata?: Record<string, unknown> }) {
  await queryOne(
    `INSERT INTO account_security_events (actor_user_id, target_user_id, event_type, result, metadata)
     VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
    [input.actorUserId ?? null, input.targetUserId ?? null, input.eventType, input.result, JSON.stringify(input.metadata ?? {})],
  );
}

async function deliverInvitation(row: InvitationRow, token: string): Promise<void> {
  const result = await getAccountMailProvider().send({
    ...composeAccountMail({ version: 1, kind: 'account_invitation', origin: publicOrigin(), token }, row.email, `account-invitation:${row.id}:${row.token_hash}`, process.env.NODE_ENV === 'test'),
  });
  await queryOne(
    `UPDATE account_email_invitations SET provider_message_id=$2, last_sent_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING id`,
    [row.id, result.providerMessageId],
  );
}

async function deliverVerification(input: { challengeId: string; email: string; token: string; tokenHash: string }): Promise<void> {
  const result = await getAccountMailProvider().send({
    ...composeAccountMail({ version: 1, kind: 'email_verification', origin: publicOrigin(), token: input.token }, input.email, `account-email-verification:${input.challengeId}:${input.tokenHash}`, process.env.NODE_ENV === 'test'),
  });
  await queryOne(
    `UPDATE account_email_verification_challenges SET provider_message_id=$2 WHERE id=$1 RETURNING id`,
    [input.challengeId, result.providerMessageId],
  );
}

export async function listAccountEmailInvitations() {
  const rows = await query<any>(
    `SELECT i.id, i.email, i.role, i.display_name, i.affiliation, i.status, i.expires_at,
            i.last_sent_at, i.created_at, u.username AS created_by_username
       FROM account_email_invitations i LEFT JOIN users u ON u.id=i.created_by
      ORDER BY i.created_at DESC`,
  );
  return rows.map((row) => ({ ...row, masked_email: maskAccountEmail(row.email) }));
}

export async function createAccountEmailInvitation(input: { email: string; role?: string; displayName?: string | null; affiliation?: string | null; createdBy: number }) {
  const { email, normalized } = normalizeAccountEmail(input.email);
  const role = input.role || 'member';
  if (!EMAIL_ROLES.has(role)) throw new AccountEmailStateError('Invalid invitation role');
  await assertEmailAvailable(normalized);
  const token = createOpaqueAccountToken();
  const tokenHash = hashAccountSecret(token, pepper());
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS).toISOString();
  const row = await queryOne<InvitationRow>(
    `INSERT INTO account_email_invitations
      (email,email_normalized,role,display_name,affiliation,token_hash,expires_at,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [email, normalized, role, input.displayName?.trim() || null, input.affiliation?.trim() || null, tokenHash, expiresAt, input.createdBy],
  );
  try { await deliverInvitation(row!, token); }
  catch (error) {
    await audit({ actorUserId: input.createdBy, eventType: 'account_invitation_delivery_failed', result: 'failure', metadata: { invitationId: row!.id } });
    throw new AccountEmailDeliveryError(error instanceof Error ? error.message : 'Invitation delivery failed');
  }
  await audit({ actorUserId: input.createdBy, eventType: 'account_invitation_created', result: 'success', metadata: { invitationId: row!.id } });
  return { id: row!.id, email, maskedEmail: maskAccountEmail(email), role, status: row!.status, expiresAt };
}

export async function resendAccountEmailInvitation(id: string, actorUserId: number) {
  const current = await queryOne<InvitationRow>('SELECT * FROM account_email_invitations WHERE id=$1', [id]);
  if (!current || current.status !== 'pending' || new Date(current.expires_at).getTime() <= Date.now()) throw new AccountEmailNotFoundError('Pending invitation not found');
  const token = createOpaqueAccountToken();
  const tokenHash = hashAccountSecret(token, pepper());
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS).toISOString();
  const row = await queryOne<InvitationRow>(
    `UPDATE account_email_invitations SET token_hash=$2, expires_at=$3, provider_message_id=NULL, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [id, tokenHash, expiresAt],
  );
  try { await deliverInvitation(row!, token); }
  catch (error) { throw new AccountEmailDeliveryError(error instanceof Error ? error.message : 'Invitation delivery failed'); }
  await audit({ actorUserId, eventType: 'account_invitation_resent', result: 'success', metadata: { invitationId: id } });
  return { id, maskedEmail: maskAccountEmail(row!.email), status: 'pending', expiresAt };
}

export async function cancelAccountEmailInvitation(id: string, actorUserId: number): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE account_email_invitations SET status='cancelled', cancelled_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND status='pending' RETURNING id`, [id],
  );
  if (row) await audit({ actorUserId, eventType: 'account_invitation_cancelled', result: 'success', metadata: { invitationId: id } });
  return !!row;
}

export async function inspectAccountEmailInvitation(token: string) {
  const tokenHash = hashAccountSecret(token, pepper());
  const row = await queryOne<InvitationRow>('SELECT * FROM account_email_invitations WHERE token_hash=$1', [tokenHash]);
  if (!row || row.status !== 'pending' || new Date(row.expires_at).getTime() <= Date.now()) throw new AccountEmailNotFoundError('Invitation is invalid or expired');
  return { maskedEmail: maskAccountEmail(row.email), role: row.role, displayName: row.display_name, affiliation: row.affiliation, expiresAt: row.expires_at };
}

export async function acceptAccountEmailInvitation(input: { token: string; username: string; password: string; passwordConfirm: string; displayName: string; affiliation?: string | null }) {
  const username = input.username.trim();
  const displayName = input.displayName.trim();
  if (!USERNAME_RE.test(username)) throw new InvalidUsernameError(username);
  if (!input.password || input.password.length < 8) throw new AccountEmailStateError('Password must be at least 8 characters');
  if (input.password !== input.passwordConfirm) throw new AccountEmailStateError('Passwords do not match');
  if (!displayName) throw new AccountEmailStateError('Display name is required');
  const tokenHash = hashAccountSecret(input.token, pepper());
  const encrypted = await hashPassword(input.password);
  const result = await transaction(async (client) => {
    const inviteRes = await client.query<InvitationRow>('SELECT * FROM account_email_invitations WHERE token_hash=$1 FOR UPDATE', [tokenHash]);
    const invite = inviteRes.rows[0];
    if (!invite || invite.status !== 'pending' || new Date(invite.expires_at).getTime() <= Date.now()) throw new AccountEmailNotFoundError('Invitation is invalid or expired');
    if ((await client.query('SELECT 1 FROM users WHERE username=$1', [username])).rows[0]) throw new UsernameTakenError(username);
    const userRes = await client.query<{ id:number; username:string; role:string }>(
      `INSERT INTO users (username,password_hash,role,display_name,affiliation,approval_status,approved_by,approved_at,password_changed_at)
       VALUES ($1,$2,$3,$4,$5,'active',$6,NOW(),NOW()) RETURNING id,username,role`,
      [username, encrypted, invite.role, displayName, input.affiliation?.trim() || invite.affiliation || null, invite.created_by],
    );
    const user = userRes.rows[0];
    const identityRes = await client.query<{ id:number }>(
      `INSERT INTO account_email_identities (user_id,email,email_normalized,state,purpose,verified_at,created_by)
       VALUES ($1,$2,$3,'verified','invite',NOW(),$4) RETURNING id`,
      [user.id, invite.email, invite.email_normalized, invite.created_by],
    );
    await client.query('UPDATE users SET primary_email_identity_id=$2 WHERE id=$1', [user.id, identityRes.rows[0].id]);
    await client.query(`UPDATE account_email_invitations SET status='accepted',accepted_by=$2,accepted_at=NOW(),updated_at=NOW() WHERE id=$1`, [invite.id, user.id]);
    return user;
  });
  await autoJoinDefaultProjects(result.id, result.username, result.role);
  await audit({ targetUserId: result.id, eventType: 'account_invitation_accepted', result: 'success' });
  return result;
}

export async function createAdminManagedAccount(input: { username:string; password:string; passwordConfirm:string; role:string; displayName:string; affiliation?:string|null; email:string; actorUserId:number; requestIp?:string|null; userAgent?:string|null }) {
  const mailReadiness=await getAccountMailProvider().checkConnection().catch(()=>({configured:true,connection:'error' as const}));
  if (!mailReadiness.configured || mailReadiness.connection!=='ok') throw new AccountEmailDeliveryError('Account mail provider is not ready');
  const username=input.username.trim(); const displayName=input.displayName.trim();
  if (!USERNAME_RE.test(username)) throw new InvalidUsernameError(username);
  if (!input.password || input.password.length < 8) throw new AccountEmailStateError('Password must be at least 8 characters');
  if (input.password !== input.passwordConfirm) throw new AccountEmailStateError('Passwords do not match');
  if (!displayName) throw new AccountEmailStateError('Display name is required');
  if (!EMAIL_ROLES.has(input.role)) throw new AccountEmailStateError('Invalid account role');
  const {email,normalized}=normalizeAccountEmail(input.email); await assertEmailAvailable(normalized);
  const token=createOpaqueAccountToken(); const tokenHash=hashAccountSecret(token,pepper());
  const expiresAt=new Date(Date.now()+VERIFICATION_TTL_MS).toISOString(); const encrypted=await hashPassword(input.password);
  const created=await transaction(async(client)=>{
    if ((await client.query('SELECT 1 FROM users WHERE username=$1',[username])).rows[0]) throw new UsernameTakenError(username);
    const user=(await client.query<{id:number;username:string;role:string;approval_status:string}>(
      `INSERT INTO users (username,password_hash,role,display_name,affiliation,approval_status,password_changed_at,approved_by,approved_at)
       VALUES ($1,$2,$3,$4,$5,'pending',NOW(),$6,NOW()) RETURNING id,username,role,approval_status`,
      [username,encrypted,input.role,displayName,input.affiliation?.trim()||null,input.actorUserId],
    )).rows[0];
    const identity=(await client.query<{id:number}>(
      `INSERT INTO account_email_identities (user_id,email,email_normalized,state,purpose,created_by)
       VALUES ($1,$2,$3,'pending','existing_user',$4) RETURNING id`,[user.id,email,normalized,input.actorUserId],
    )).rows[0];
    const challenge=(await client.query<{id:string}>(
      `INSERT INTO account_email_verification_challenges (user_id,email_identity_id,token_hash,expires_at,request_ip,user_agent)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,[user.id,identity.id,tokenHash,expiresAt,input.requestIp??null,input.userAgent??null],
    )).rows[0];
    return {user,identityId:identity.id,challengeId:challenge.id};
  });
  try { await deliverVerification({challengeId:created.challengeId,email,token,tokenHash}); }
  catch(error){ await queryOne(`UPDATE account_email_verification_challenges SET status='delivery_failed' WHERE id=$1 RETURNING id`,[created.challengeId]); throw new AccountEmailDeliveryError(error instanceof Error?error.message:'Verification delivery failed'); }
  await audit({actorUserId:input.actorUserId,targetUserId:created.user.id,eventType:'admin_managed_account_created',result:'success',metadata:{identityId:created.identityId}});
  return {...created.user,display_name:displayName,affiliation:input.affiliation?.trim()||null,account_email:maskAccountEmail(email),account_email_status:'pending'};
}

export async function registerExistingUserEmail(input: { userId: number; email: string; actorUserId: number; requestIp?: string | null; userAgent?: string | null }) {
  const mailReadiness = await getAccountMailProvider().checkConnection().catch(() => ({ configured: true, connection: 'error' as const }));
  if (!mailReadiness.configured || mailReadiness.connection !== 'ok') throw new AccountEmailDeliveryError('Account mail provider is not ready');
  const user = await queryOne<{ id:number; disabled:number }>('SELECT id,disabled FROM users WHERE id=$1', [input.userId]);
  if (!user || Number(user.disabled) === 1) throw new AccountEmailNotFoundError('User not found');
  const { email, normalized } = normalizeAccountEmail(input.email);
  await assertEmailAvailable(normalized, input.userId);
  const token = createOpaqueAccountToken();
  const tokenHash = hashAccountSecret(token, pepper());
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS).toISOString();
  const created = await transaction(async (client) => {
    // Reuse this account's reserved address: cancelled/pending rows retain the
    // globally unique email key, so inserting again would fail with 23505.
    const existing = (await client.query<{id:number;user_id:number;state:string}>(
      `SELECT id,user_id,state FROM account_email_identities WHERE email_normalized=$1 FOR UPDATE`, [normalized],
    )).rows[0];
    if (existing && (existing.user_id !== input.userId || existing.state === 'verified')) {
      throw new AccountEmailConflictError('Email is already in use');
    }
    await client.query(`UPDATE account_email_identities SET state='cancelled',updated_at=NOW() WHERE user_id=$1 AND state='pending'`, [input.userId]);
    const identity = existing
      ? (await client.query<{id:number}>(
        `UPDATE account_email_identities SET email=$2,state='pending',purpose='existing_user',created_by=$3,updated_at=NOW()
         WHERE id=$1 RETURNING id`, [existing.id,email,input.actorUserId],
      )).rows[0]
      : (await client.query<{id:number}>(
        `INSERT INTO account_email_identities (user_id,email,email_normalized,state,purpose,created_by)
         VALUES ($1,$2,$3,'pending','existing_user',$4) RETURNING id`, [input.userId,email,normalized,input.actorUserId],
      )).rows[0];
    await client.query(`UPDATE account_email_verification_challenges SET status='superseded',superseded_at=NOW()
      WHERE email_identity_id=$1 AND status='pending'`, [identity.id]);
    const challenge = (await client.query<{id:string}>(
      `INSERT INTO account_email_verification_challenges
       (user_id,email_identity_id,token_hash,expires_at,request_ip,user_agent)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [input.userId,identity.id,tokenHash,expiresAt,input.requestIp ?? null,input.userAgent ?? null],
    )).rows[0];
    return { identityId: identity.id, challengeId: challenge.id };
  });
  try { await deliverVerification({ challengeId: created.challengeId, email, token, tokenHash }); }
  catch (error) {
    // Do not advertise an undelivered address as awaiting verification. Keep the
    // failed challenge for diagnosis, but release the identity for a fresh attempt.
    await transaction(async (client) => {
      await client.query(`UPDATE account_email_verification_challenges SET status='delivery_failed'
        WHERE id=$1 AND status='pending'`, [created.challengeId]);
      await client.query(`UPDATE account_email_identities SET state='cancelled',updated_at=NOW()
        WHERE id=$1 AND state='pending' AND NOT EXISTS (
          SELECT 1 FROM account_email_verification_challenges
          WHERE email_identity_id=$1 AND status IN ('consumed','pending')
        )`, [created.identityId]);
    });
    throw new AccountEmailDeliveryError(error instanceof Error ? error.message : 'Verification delivery failed');
  }
  await audit({ actorUserId: input.actorUserId, targetUserId: input.userId, eventType: 'existing_user_email_registered', result: 'success', metadata: { identityId: created.identityId } });
  return { userId: input.userId, maskedEmail: maskAccountEmail(email), emailStatus: 'pending', expiresAt };
}

export async function resendExistingUserEmail(userId: number, actorUserId: number) {
  const mailReadiness = await getAccountMailProvider().checkConnection().catch(() => ({ configured: true, connection: 'error' as const }));
  if (!mailReadiness.configured || mailReadiness.connection !== 'ok') throw new AccountEmailDeliveryError('Account mail provider is not ready');
  const identity = await queryOne<{id:number;email:string}>(
    `SELECT id,email FROM account_email_identities WHERE user_id=$1 AND state='pending' AND purpose='existing_user' ORDER BY created_at DESC LIMIT 1`, [userId],
  );
  if (!identity) throw new AccountEmailNotFoundError('Pending email not found');
  await queryOne(`UPDATE account_email_verification_challenges SET status='superseded',superseded_at=NOW() WHERE email_identity_id=$1 AND status='pending' RETURNING id`, [identity.id]);
  const token = createOpaqueAccountToken(); const tokenHash = hashAccountSecret(token, pepper());
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS).toISOString();
  const challenge = await queryOne<{id:string}>(
    `INSERT INTO account_email_verification_challenges (user_id,email_identity_id,token_hash,expires_at) VALUES ($1,$2,$3,$4) RETURNING id`,
    [userId,identity.id,tokenHash,expiresAt],
  );
  try { await deliverVerification({ challengeId: challenge!.id, email: identity.email, token, tokenHash }); }
  catch (error) {
    await transaction(async (client) => {
      await client.query(`UPDATE account_email_verification_challenges SET status='delivery_failed'
        WHERE id=$1 AND status='pending'`, [challenge!.id]);
      await client.query(`UPDATE account_email_identities SET state='cancelled',updated_at=NOW()
        WHERE id=$1 AND state='pending' AND NOT EXISTS (
          SELECT 1 FROM account_email_verification_challenges
          WHERE email_identity_id=$1 AND status IN ('consumed','pending')
        )`, [identity.id]);
    });
    throw new AccountEmailDeliveryError(error instanceof Error ? error.message : 'Verification delivery failed');
  }
  await audit({ actorUserId, targetUserId:userId, eventType:'existing_user_email_resent', result:'success' });
  return { userId, maskedEmail:maskAccountEmail(identity.email), emailStatus:'pending', expiresAt };
}

export async function cancelPendingExistingUserEmail(userId: number, actorUserId: number): Promise<boolean> {
  const identity = await queryOne<{id:number}>(
    `UPDATE account_email_identities SET state='cancelled',updated_at=NOW()
      WHERE user_id=$1 AND state='pending' AND purpose='existing_user' RETURNING id`, [userId],
  );
  if (!identity) return false;
  await queryOne(`UPDATE account_email_verification_challenges SET status='cancelled' WHERE email_identity_id=$1 AND status='pending' RETURNING id`, [identity.id]);
  await audit({ actorUserId,targetUserId:userId,eventType:'existing_user_email_cancelled',result:'success' });
  return true;
}

export async function verifyExistingUserEmail(token: string) {
  const tokenHash = hashAccountSecret(token, pepper());
  const result = await transaction(async (client) => {
    // Match login enrollment's user -> identity -> challenge lock order. A stale
    // link must never race an OTP consumption into replacing the primary email.
    const owner = (await client.query<{user_id:number;email_identity_id:number}>(
      'SELECT user_id,email_identity_id FROM account_email_verification_challenges WHERE token_hash=$1', [tokenHash],
    )).rows[0];
    if (!owner) throw new AccountEmailNotFoundError('Verification link is invalid or expired');
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner.user_id]);
    const identity = (await client.query<{state:string;email:string}>(
      'SELECT state,email FROM account_email_identities WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [owner.email_identity_id,owner.user_id],
    )).rows[0];
    const challenge = (await client.query<any>(
      'SELECT * FROM account_email_verification_challenges WHERE token_hash=$1 FOR UPDATE', [tokenHash],
    )).rows[0];
    if (!challenge || challenge.user_id!==owner.user_id || challenge.email_identity_id!==owner.email_identity_id || challenge.status !== 'pending' || new Date(challenge.expires_at).getTime() <= Date.now() || identity?.state !== 'pending') throw new AccountEmailNotFoundError('Verification link is invalid or expired');
    await client.query(`UPDATE account_email_identities SET state='superseded',updated_at=NOW() WHERE user_id=$1 AND state='verified'`, [challenge.user_id]);
    await client.query(`UPDATE account_email_identities SET state='verified',verified_at=NOW(),updated_at=NOW() WHERE id=$1`, [challenge.email_identity_id]);
    await client.query(`UPDATE users SET primary_email_identity_id=$2 WHERE id=$1`, [challenge.user_id,challenge.email_identity_id]);
    await client.query(`UPDATE account_email_verification_challenges SET status='consumed',consumed_at=NOW() WHERE id=$1`, [challenge.id]);
    const user=(await client.query<{username:string;role:string;approval_status:string}>(
      `UPDATE users SET approval_status='active',approved_at=COALESCE(approved_at,NOW())
        WHERE id=$1 AND approval_status='pending' AND approved_by IS NOT NULL AND approved_at IS NOT NULL
        RETURNING username,role,approval_status`,[challenge.user_id],
    )).rows[0];
    return { userId:challenge.user_id,email:identity.email,user };
  });
  if (result.user?.approval_status === 'active') await autoJoinDefaultProjects(result.userId,result.user.username,result.user.role);
  await audit({ targetUserId:result.userId,eventType:'existing_user_email_verified',result:'success' });
  return { userId:result.userId,maskedEmail:maskAccountEmail(result.email),emailStatus:'verified' };
}
