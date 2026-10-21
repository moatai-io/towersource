import { config } from '../../config.js';
import { queryOne, transaction } from '../../db/pg-repo.js';
import type { JwtPayload } from '../auth/auth.js';
import { loginEmailEnrollmentCutoff, parseLoginOtpPilotUserIds, getAccountSecurityConfig, requiresBrowserLoginOtp } from './config.js';
import { getAccountMailProvider } from './mail/mail-service.js';
import { composeAccountMail } from './mail/account-mail-template.js';
import { calculateAccountEmailReadiness } from './readiness.js';
import { accountSecretMatches, createLoginOtp, hashAccountSecret } from './secrets.js';

const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_DELAY_MS = 60 * 1000;
const SEND_WINDOW_MINUTES = 15;
const MAX_SENDS_PER_WINDOW = 5;
const MAX_FAILED_ATTEMPTS = 5;

export class LoginOtpNotReadyError extends Error { readonly code = 'LOGIN_OTP_NOT_READY'; }
export class LoginOtpDeliveryError extends Error { readonly code = 'LOGIN_OTP_DELIVERY'; }
export class LoginOtpNotFoundError extends Error { readonly code = 'LOGIN_OTP_NOT_FOUND'; }
export class LoginOtpStateError extends Error { readonly code = 'LOGIN_OTP_STATE'; }
export class LoginOtpRateLimitError extends Error { readonly code = 'LOGIN_OTP_RATE_LIMIT'; }
export class LoginOtpInvalidError extends Error { readonly code = 'LOGIN_OTP_INVALID'; }

interface IdentityRow { id: number; email: string; }
interface ChallengeRow {
  id: string;
  user_id: number;
  email_identity_id: number;
  email: string;
  otp_hash: string;
  status: string;
  failed_attempts: number;
  expires_at: string;
  resend_available_at: string;
  auth_epoch: number | null;
}

function pepper(): string {
  return process.env.TOWER_ACCOUNT_SECURITY_PEPPER || config.jwtSecret;
}

function maskedDestination(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

async function audit(input: { userId: number; eventType: string; result: 'success'|'failure'|'blocked'; requestIp?: string|null; userAgent?: string|null; metadata?: Record<string, unknown> }) {
  await queryOne(
    `INSERT INTO account_security_events (target_user_id,event_type,result,ip_address,user_agent,metadata)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,
    [input.userId,input.eventType,input.result,input.requestIp??null,input.userAgent??null,JSON.stringify(input.metadata??{})],
  );
}

export async function getAccountEmailReadiness() {
  const securityConfig = getAccountSecurityConfig();
  const cutoff = loginEmailEnrollmentCutoff();
  const excluded = [...parseLoginOtpPilotUserIds(process.env.TOWER_LOGIN_EMAIL_OTP_EXCLUDED_USER_IDS)];
  const counts = await queryOne<{ active_accounts: string; verified_active_accounts: string; enrollable_active_accounts:string }>(
    `SELECT COUNT(*) FILTER (WHERE u.disabled=0 AND u.approval_status='active') AS active_accounts,
            COUNT(*) FILTER (WHERE u.disabled=0 AND u.approval_status='active' AND ei.id IS NOT NULL) AS verified_active_accounts,
            COUNT(*) FILTER (WHERE u.disabled=0 AND u.approval_status='active' AND ei.id IS NULL AND u.id<=$1) AS enrollable_active_accounts
       FROM users u
       LEFT JOIN account_email_identities ei
         ON ei.id=u.primary_email_identity_id AND ei.user_id=u.id AND ei.state='verified'
      WHERE NOT (u.id=ANY($2::integer[]))`, [cutoff,excluded],
  );
  const mail = await getAccountMailProvider().checkConnection().catch(() => ({ configured: true, connection: 'error' as const }));
  return calculateAccountEmailReadiness({
    policy: securityConfig.loginEmailOtpPolicy,
    activeAccounts: Number(counts?.active_accounts ?? 0),
    verifiedActiveAccounts: Number(counts?.verified_active_accounts ?? 0),
    enrollableActiveAccounts: Number(counts?.enrollable_active_accounts ?? 0),
    mailProviderConfigured: mail.configured,
    providerConnection: mail.connection,
  });
}

async function assertRequiredReadiness(userId: number): Promise<void> {
  const mail = await getAccountMailProvider().checkConnection().catch(() => ({ configured: true, connection: 'error' as const }));
  if (!mail.configured || mail.connection !== 'ok') throw new LoginOtpNotReadyError('Email OTP mail provider is not ready');
  // Only explicitly cutoff-eligible missing-email accounts are exempt from the
  // global coverage gate in opt-in enrollment mode; they must enroll, never fail open.
  if (getAccountSecurityConfig().loginEmailOtpPolicy === 'required') {
    const readiness = await getAccountEmailReadiness();
    if (!readiness.ready) throw new LoginOtpNotReadyError(`Email OTP is not ready: ${readiness.blockers.join(',')}`);
  }
}

async function deliver(challenge: ChallengeRow, otp: string): Promise<void> {
  const result = await getAccountMailProvider().send({
    ...composeAccountMail({ version: 1, kind: 'login_otp', variant: 'login', code: otp }, challenge.email, `login-otp:${challenge.id}:${challenge.otp_hash}`),
  });
  await queryOne('UPDATE auth_login_otp_challenges SET provider_message_id=$2 WHERE id=$1 RETURNING id', [challenge.id,result.providerMessageId]);
}

async function issue(input: { payload: JwtPayload; previousChallengeId?: string; requestIp?: string|null; userAgent?: string|null }) {
  const otp = createLoginOtp();
  const otpHash = hashAccountSecret(otp, pepper());
  const expiresAt = new Date(Date.now()+OTP_TTL_MS).toISOString();
  const resendAvailableAt = new Date(Date.now()+RESEND_DELAY_MS).toISOString();
  const challenge = await transaction(async (client) => {
    const current=(await client.query<{auth_epoch:number;username:string}>('SELECT auth_epoch,username FROM users WHERE id=$1 FOR UPDATE',[input.payload.userId])).rows[0];
    if (!current || (input.payload.authEpoch !== undefined && Number(current.auth_epoch)!==Number(input.payload.authEpoch))) throw new LoginOtpStateError('Credential changed; login again');
    if (!input.previousChallengeId && current.username!==input.payload.username) throw new LoginOtpStateError('Account identity changed; login again');
    if (input.previousChallengeId) {
      const previous=(await client.query<ChallengeRow>(
        `SELECT c.*,i.email FROM auth_login_otp_challenges c JOIN account_email_identities i ON i.id=c.email_identity_id
          WHERE c.id=$1 AND c.user_id=$2 FOR UPDATE`,[input.previousChallengeId,input.payload.userId],
      )).rows[0];
      if (!previous || previous.status!=='pending') throw new LoginOtpNotFoundError('Pending OTP challenge not found');
      if (previous.auth_epoch==null || Number(previous.auth_epoch)!==Number(current.auth_epoch)) throw new LoginOtpStateError('Credential changed; login again');
      if (new Date(previous.resend_available_at).getTime()>Date.now()) throw new LoginOtpRateLimitError('OTP resend is not available yet');
    }
    const sends=(await client.query<{ count:string }>(
      `SELECT (SELECT COUNT(*) FROM auth_login_otp_challenges WHERE user_id=$1 AND created_at > NOW() - INTERVAL '${SEND_WINDOW_MINUTES} minutes') + (SELECT COUNT(*) FROM auth_login_email_enrollments WHERE user_id=$1 AND email<>'' AND created_at > NOW() - INTERVAL '${SEND_WINDOW_MINUTES} minutes') AS count`,
      [input.payload.userId],
    )).rows[0];
    if (Number(sends?.count??0)>=MAX_SENDS_PER_WINDOW) throw new LoginOtpRateLimitError('OTP send limit exceeded');
    const identity=(await client.query<IdentityRow>(
      `SELECT i.id,i.email FROM users u JOIN account_email_identities i ON i.id=u.primary_email_identity_id
        WHERE u.id=$1 AND u.disabled=0 AND u.approval_status='active' AND i.user_id=u.id AND i.state='verified' FOR UPDATE`,
      [input.payload.userId],
    )).rows[0];
    if (!identity) throw new LoginOtpNotReadyError('Verified primary email is required');
    await client.query(`UPDATE auth_login_otp_challenges SET status='superseded',superseded_at=NOW() WHERE user_id=$1 AND status='pending'`,[input.payload.userId]);
    return (await client.query<ChallengeRow>(
      `INSERT INTO auth_login_otp_challenges
       (user_id,email_identity_id,otp_hash,expires_at,resend_available_at,request_ip,user_agent,auth_epoch)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$9) RETURNING *, $8::text AS email`,
      [input.payload.userId,identity.id,otpHash,expiresAt,resendAvailableAt,input.requestIp??null,input.userAgent??null,identity.email,Number(current.auth_epoch)],
    )).rows[0];
  });
  try { await deliver(challenge,otp); }
  catch(error) {
    await queryOne(`UPDATE auth_login_otp_challenges SET status='delivery_failed' WHERE id=$1 AND status='pending' RETURNING id`,[challenge.id]);
    await audit({userId:input.payload.userId,eventType:'login_otp_delivery_failed',result:'failure',requestIp:input.requestIp,userAgent:input.userAgent});
    throw new LoginOtpDeliveryError(error instanceof Error?error.message:'OTP delivery failed');
  }
  await audit({userId:input.payload.userId,eventType:input.previousChallengeId?'login_otp_resent':'login_otp_created',result:'success',requestIp:input.requestIp,userAgent:input.userAgent});
  return { otpRequired:true as const, challengeId:challenge.id, maskedEmail:maskedDestination(challenge.email), expiresAt, resendAvailableAt };
}

export async function createLoginOtpChallenge(input: { payload: JwtPayload; requestIp?: string|null; userAgent?: string|null }) {
  await assertRequiredReadiness(input.payload.userId);
  return issue(input);
}

export async function resendLoginOtpChallenge(input: { challengeId:string; requestIp?:string|null; userAgent?:string|null }) {
  const row=await queryOne<{user_id:number;username:string;role:string}>(
    `SELECT c.user_id,u.username,u.role FROM auth_login_otp_challenges c JOIN users u ON u.id=c.user_id WHERE c.id=$1`,[input.challengeId],
  );
  if (!row) throw new LoginOtpNotFoundError('OTP challenge not found');
  if (!requiresBrowserLoginOtp(row.user_id)) throw new LoginOtpStateError('OTP pilot is no longer active');
  await assertRequiredReadiness(row.user_id);
  return issue({payload:{userId:row.user_id,username:row.username,role:row.role},previousChallengeId:input.challengeId,requestIp:input.requestIp,userAgent:input.userAgent});
}

export async function verifyLoginOtpChallenge(input: { challengeId:string; otp:string; requestIp?:string|null; userAgent?:string|null }): Promise<JwtPayload> {
  if (typeof input.otp !== 'string' || !/^\d{6}$/.test(input.otp)) throw new LoginOtpInvalidError('OTP must be 6 digits');
  const outcome=await transaction(async(client)=>{
    const hint=(await client.query<{user_id:number}>('SELECT user_id FROM auth_login_otp_challenges WHERE id=$1',[input.challengeId])).rows[0];
    if (!hint) return {kind:'not_found' as const};
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[hint.user_id]);
    const row=(await client.query<ChallengeRow & {username:string;role:string;disabled:number|boolean;approval_status:string;current_auth_epoch:number}>(
      `SELECT c.*,i.email,u.username,u.role,u.disabled,u.approval_status,u.auth_epoch AS current_auth_epoch
         FROM auth_login_otp_challenges c JOIN users u ON u.id=c.user_id JOIN account_email_identities i ON i.id=c.email_identity_id
        WHERE c.id=$1 FOR UPDATE`,[input.challengeId],
    )).rows[0];
    if (!row || row.status!=='pending') return {kind:'not_found' as const};
    if (!requiresBrowserLoginOtp(row.user_id)) return {kind:'pilot_disabled' as const};
    if (row.disabled===true || Number(row.disabled)===1 || row.approval_status!=='active' || row.auth_epoch==null || Number(row.auth_epoch)!==Number(row.current_auth_epoch)) {
      await client.query(`UPDATE auth_login_otp_challenges SET status='cancelled' WHERE id=$1`,[row.id]);
      return {kind:'inactive' as const,userId:row.user_id};
    }
    if (new Date(row.expires_at).getTime()<=Date.now()) {
      await client.query(`UPDATE auth_login_otp_challenges SET status='expired' WHERE id=$1`,[row.id]);
      return {kind:'expired' as const,userId:row.user_id};
    }
    if (!accountSecretMatches(input.otp,row.otp_hash,pepper())) {
      const attempts=row.failed_attempts+1;
      await client.query(`UPDATE auth_login_otp_challenges SET failed_attempts=$2::integer,status=CASE WHEN $2::integer >= $3::integer THEN 'attempts_exceeded' ELSE status END WHERE id=$1`,[row.id,attempts,MAX_FAILED_ATTEMPTS]);
      return {kind:'invalid' as const,userId:row.user_id,attempts};
    }
    await client.query(`UPDATE auth_login_otp_challenges SET status='consumed',consumed_at=NOW() WHERE id=$1`,[row.id]);
    return {kind:'success' as const,payload:{userId:row.user_id,username:row.username,role:row.role,authEpoch:Number(row.current_auth_epoch)}};
  });
  if (outcome.kind==='not_found') throw new LoginOtpNotFoundError('Pending OTP challenge not found');
  if (outcome.kind==='pilot_disabled') throw new LoginOtpStateError('OTP pilot is no longer active');
  if (outcome.kind==='inactive') throw new LoginOtpStateError('Account is no longer active');
  if (outcome.kind==='expired') throw new LoginOtpStateError('OTP challenge expired');
  if (outcome.kind==='invalid') {
    await audit({userId:outcome.userId,eventType:'login_otp_failed',result:'failure',requestIp:input.requestIp,userAgent:input.userAgent,metadata:{attempts:outcome.attempts}});
    throw new LoginOtpInvalidError(outcome.attempts>=MAX_FAILED_ATTEMPTS?'OTP attempts exceeded':'Invalid OTP');
  }
  await audit({userId:outcome.payload.userId,eventType:'login_otp_verified',result:'success',requestIp:input.requestIp,userAgent:input.userAgent});
  return outcome.payload;
}

export async function cancelLoginOtpChallenge(input: { challengeId:string; requestIp?:string|null; userAgent?:string|null }): Promise<boolean> {
  const row=await queryOne<{user_id:number}>(`UPDATE auth_login_otp_challenges SET status='cancelled' WHERE id=$1 AND status='pending' RETURNING user_id`,[input.challengeId]);
  if (row) await audit({userId:row.user_id,eventType:'login_otp_cancelled',result:'success',requestIp:input.requestIp,userAgent:input.userAgent});
  return !!row;
}
