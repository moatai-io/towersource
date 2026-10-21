import { config } from '../../config.js';
import { queryOne, transaction } from '../../db/pg-repo.js';
import type { JwtPayload } from '../auth/auth.js';
import { enrollmentEnabledFor, requiresBrowserLoginOtp } from './config.js';
import { normalizeAccountEmail, maskAccountEmail, AccountEmailValidationError } from './email-normalization.js';
import { getAccountMailProvider } from './mail/mail-service.js';
import { composeAccountMail } from './mail/account-mail-template.js';
import { accountSecretMatches, createLoginOtp, hashAccountSecret } from './secrets.js';
import { LoginOtpDeliveryError, LoginOtpInvalidError, LoginOtpNotFoundError, LoginOtpNotReadyError, LoginOtpRateLimitError, LoginOtpStateError } from './login-otp-service.js';

const pepper = () => process.env.TOWER_ACCOUNT_SECURITY_PEPPER || config.jwtSecret;
const ttl = 10 * 60_000;
const resendDelay = 60_000;
type Context = { requestIp?: string | null; userAgent?: string | null };
type Enrollment = { id:string; user_id:number; email:string; email_normalized:string; otp_hash:string; status:string; failed_attempts:number; expires_at:string; resend_available_at:string; password_changed_at:string|null; auth_epoch:number };
type ReservedIdentity = { id:number; user_id:number; state:string; purpose:string };

async function mailReady() {
  const ready = await getAccountMailProvider().checkConnection().catch(() => ({ configured:true, connection:'error' as const }));
  if (!ready.configured || ready.connection !== 'ok') throw new LoginOtpNotReadyError('Email enrollment mail provider is not ready');
}
async function audit(userId:number, eventType:string, result:'success'|'failure', context:Context) {
  await queryOne(`INSERT INTO account_security_events (target_user_id,event_type,result,ip_address,user_agent) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [userId,eventType,result,context.requestIp??null,context.userAgent??null]);
}
async function eligible(userId:number) {
  if (!requiresBrowserLoginOtp(userId) || !enrollmentEnabledFor(userId)) throw new LoginOtpStateError('Email enrollment is not enabled for this account');
}
async function issue(input:{ userId:number; email:string; previousId?:string; submission?:boolean } & Context) {
  await eligible(input.userId);
  const {email,normalized} = normalizeAccountEmail(input.email);
  await mailReady();
  const otp=createLoginOtp(), otpHash=hashAccountSecret(otp,pepper());
  const expiresAt=new Date(Date.now()+ttl).toISOString(), resendAvailableAt=new Date(Date.now()+resendDelay).toISOString();
  const challenge=await transaction(async(client)=>{
    // All enrollment and OTP issuance for this user serialize on the same account row.
    const user=(await client.query<{id:number;disabled:number;approval_status:string;password_changed_at:string|null;primary_email_identity_id:number|null;auth_epoch:number}>(
      'SELECT id,disabled,approval_status,password_changed_at,primary_email_identity_id,auth_epoch FROM users WHERE id=$1 FOR UPDATE',[input.userId])).rows[0];
    if (!user || Number(user.disabled)!==0 || user.approval_status!=='active' || user.primary_email_identity_id || (await client.query("SELECT 1 FROM account_email_identities WHERE user_id=$1 AND state='verified' LIMIT 1",[input.userId])).rows[0]) throw new LoginOtpStateError('Account is not eligible for email enrollment');
    if (input.previousId) {
      const prior=(await client.query<Enrollment>('SELECT * FROM auth_login_email_enrollments WHERE id=$1 AND user_id=$2 FOR UPDATE',[input.previousId,input.userId])).rows[0];
      if (!prior || prior.status!=='pending') throw new LoginOtpNotFoundError('Pending enrollment not found');
      if (new Date(prior.expires_at).getTime()<=Date.now()) throw new LoginOtpStateError('Enrollment expired');
      if (new Date(prior.resend_available_at).getTime()>Date.now()) throw new LoginOtpRateLimitError('Enrollment resend is not available yet');
      if (input.submission ? Boolean(prior.email) : prior.email_normalized!==normalized) throw new LoginOtpStateError('Enrollment address changed');
      if (new Date(prior.password_changed_at||0).getTime()!==new Date(user.password_changed_at||0).getTime() || Number(prior.auth_epoch)!==Number(user.auth_epoch)) throw new LoginOtpStateError('Account credentials changed');
    }
    const recent=(await client.query<{resend_available_at:string}>("SELECT resend_available_at FROM auth_login_email_enrollments WHERE user_id=$1 AND email<>'' ORDER BY created_at DESC LIMIT 1",[input.userId])).rows[0];
    if (recent && new Date(recent.resend_available_at).getTime()>Date.now()) throw new LoginOtpRateLimitError('Email code resend is not available yet');
    const sends=(await client.query<{count:string}>(`SELECT (SELECT COUNT(*) FROM auth_login_email_enrollments WHERE user_id=$1 AND email<>'' AND created_at>NOW()-INTERVAL '15 minutes') + (SELECT COUNT(*) FROM auth_login_otp_challenges WHERE user_id=$1 AND created_at>NOW()-INTERVAL '15 minutes') AS count`,[input.userId])).rows[0];
    if (Number(sends.count)>=5) throw new LoginOtpRateLimitError('Email code send limit exceeded');
    // The only reusable reservation is this account's pending existing-user identity.
    // Keep its identity row locked through challenge issuance; never convert it before OTP consumption.
    const reserved=(await client.query<ReservedIdentity>('SELECT id,user_id,state,purpose FROM account_email_identities WHERE email_normalized=$1 FOR UPDATE',[normalized])).rows[0];
    const invited=(await client.query("SELECT 1 FROM account_email_invitations WHERE email_normalized=$1 AND status='pending' LIMIT 1",[normalized])).rows[0];
    if ((reserved && (reserved.user_id!==input.userId || reserved.state!=='pending' || reserved.purpose!=='existing_user')) || invited) throw new LoginOtpStateError('Email address is unavailable');
    await client.query("UPDATE auth_login_email_enrollments SET status='superseded' WHERE user_id=$1 AND status='pending'",[input.userId]);
    const created=(await client.query<Enrollment>(`INSERT INTO auth_login_email_enrollments (user_id,email,email_normalized,otp_hash,password_changed_at,auth_epoch,expires_at,resend_available_at,request_ip,user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[input.userId,email,normalized,otpHash,user.password_changed_at,user.auth_epoch,expiresAt,resendAvailableAt,input.requestIp??null,input.userAgent??null])).rows[0];
    return created;
  });
  try {
    const sent=await getAccountMailProvider().send({...composeAccountMail({version:1,kind:'login_otp',variant:'enrollment',code:otp},email,`login-email-enrollment:${challenge.id}:${otpHash}`)});
    await queryOne('UPDATE auth_login_email_enrollments SET provider_message_id=$2 WHERE id=$1 RETURNING id',[challenge.id,sent.providerMessageId]);
  } catch {
    await queryOne("UPDATE auth_login_email_enrollments SET status='delivery_failed' WHERE id=$1 AND status='pending' RETURNING id",[challenge.id]);
    await audit(input.userId,'login_email_enrollment_delivery_failed','failure',input);
    throw new LoginOtpDeliveryError('Email enrollment delivery failed');
  }
  await audit(input.userId,'login_email_enrollment_sent','success',input);
  return { enrollmentRequired:true as const, challengeId:challenge.id, maskedEmail:maskAccountEmail(email), expiresAt, resendAvailableAt };
}
export async function shouldEnrollLoginEmail(userId:number) {
  if (!enrollmentEnabledFor(userId)) return false;
  const row=await queryOne<{id:number}>(`SELECT id FROM account_email_identities WHERE user_id=$1 AND state='verified'`,[userId]);
  return !row;
}
export async function startLoginEmailEnrollment(input:{payload:JwtPayload;passwordChangedAt:string|null}&Context) {
  await eligible(input.payload.userId);
  const user=await queryOne<{disabled:number;approval_status:string;primary_email_identity_id:number|null}>(`SELECT disabled,approval_status,primary_email_identity_id FROM users WHERE id=$1`,[input.payload.userId]);
  if (!user || Number(user.disabled)!==0 || user.approval_status!=='active' || user.primary_email_identity_id) throw new LoginOtpStateError('Account is not eligible for email enrollment');
  await mailReady();
  // Opaque bearer capability; no session and no email are created until the user submits an address.
  const row=await transaction(async(client)=>{
    const locked=(await client.query<{id:number;password_changed_at:string|null;auth_epoch:number}>("SELECT id,password_changed_at,auth_epoch FROM users WHERE id=$1 AND disabled=0 AND approval_status='active' AND primary_email_identity_id IS NULL FOR UPDATE",[input.payload.userId])).rows[0];
    if (!locked || new Date(locked.password_changed_at||0).getTime()!==new Date(input.passwordChangedAt||0).getTime() || Number(locked.auth_epoch)!==Number(input.payload.authEpoch) || (await client.query("SELECT 1 FROM account_email_identities WHERE user_id=$1 AND state='verified' LIMIT 1",[input.payload.userId])).rows[0]) throw new LoginOtpStateError('Account is not eligible for email enrollment');
    await client.query("UPDATE auth_login_email_enrollments SET status='superseded' WHERE user_id=$1 AND status='pending'",[input.payload.userId]);
    return (await client.query<{id:string}>(`INSERT INTO auth_login_email_enrollments (user_id,email,email_normalized,otp_hash,password_changed_at,auth_epoch,expires_at,resend_available_at,request_ip,user_agent,status)
       SELECT id,'','','',password_changed_at,auth_epoch,NOW()+INTERVAL '10 minutes',NOW(),$2,$3,'pending' FROM users WHERE id=$1 RETURNING id`,[input.payload.userId,input.requestIp??null,input.userAgent??null])).rows[0];
  });
  return { enrollmentRequired:true as const, challengeId:row.id, emailRequired:true };
}
export async function submitLoginEmailEnrollment(input:{challengeId:string;email:string}&Context) {
  const row=await queryOne<Enrollment>('SELECT * FROM auth_login_email_enrollments WHERE id=$1',[input.challengeId]);
  if (!row || row.status!=='pending') throw new LoginOtpNotFoundError('Pending enrollment not found');
  if (new Date(row.expires_at).getTime()<=Date.now()) throw new LoginOtpStateError('Enrollment expired');
  if (row.email) throw new LoginOtpStateError('Enrollment address already submitted');
  return issue({userId:row.user_id,previousId:input.challengeId,submission:true,...input});
}
export async function resendLoginEmailEnrollment(input:{challengeId:string}&Context) {
  const row=await queryOne<Enrollment>('SELECT * FROM auth_login_email_enrollments WHERE id=$1',[input.challengeId]);
  if (!row || row.status!=='pending' || !row.email) throw new LoginOtpNotFoundError('Pending enrollment not found');
  return issue({userId:row.user_id,email:row.email,previousId:input.challengeId,requestIp:input.requestIp,userAgent:input.userAgent});
}
export async function verifyLoginEmailEnrollment(input:{challengeId:string;otp:string}&Context):Promise<JwtPayload> {
  if (!/^\d{6}$/.test(input.otp)) throw new LoginOtpInvalidError('OTP must be 6 digits');
  const result=await transaction(async(client)=>{
    // Lock account before challenge, same order as issue/resend to prevent deadlocks.
    const owner=(await client.query<{user_id:number}>('SELECT user_id FROM auth_login_email_enrollments WHERE id=$1',[input.challengeId])).rows[0];
    if (!owner) return {kind:'missing' as const};
    const user=(await client.query<{id:number;username:string;role:string;disabled:number;approval_status:string;primary_email_identity_id:number|null;password_changed_at:string|null;auth_epoch:number}>(
      'SELECT id,username,role,disabled,approval_status,primary_email_identity_id,password_changed_at,auth_epoch FROM users WHERE id=$1 FOR UPDATE',[owner.user_id])).rows[0];
    const row=(await client.query<Enrollment>('SELECT * FROM auth_login_email_enrollments WHERE id=$1 FOR UPDATE',[input.challengeId])).rows[0];
    if (!row || row.status!=='pending' || !row.email) return {kind:'missing' as const};
    if (!user || Number(user.disabled)!==0 || user.approval_status!=='active' || user.primary_email_identity_id || (await client.query("SELECT 1 FROM account_email_identities WHERE user_id=$1 AND state='verified' LIMIT 1",[row.user_id])).rows[0] || !requiresBrowserLoginOtp(row.user_id) || !enrollmentEnabledFor(row.user_id) || new Date(user.password_changed_at||0).getTime()!==new Date(row.password_changed_at||0).getTime() || Number(user.auth_epoch)!==Number(row.auth_epoch)) {
      await client.query("UPDATE auth_login_email_enrollments SET status='cancelled' WHERE id=$1",[row.id]);
      return {kind:'state' as const};
    }
    if (new Date(row.expires_at).getTime()<=Date.now()) {
      await client.query("UPDATE auth_login_email_enrollments SET status='expired' WHERE id=$1",[row.id]); return {kind:'state' as const};
    }
    if (!accountSecretMatches(input.otp,row.otp_hash,pepper())) {
      await client.query("UPDATE auth_login_email_enrollments SET failed_attempts=failed_attempts+1,status=CASE WHEN failed_attempts+1>=5 THEN 'attempts_exceeded' ELSE status END WHERE id=$1",[row.id]);
      return {kind:'invalid' as const};
    }
    const reserved=(await client.query<ReservedIdentity>('SELECT id,user_id,state,purpose FROM account_email_identities WHERE email_normalized=$1 FOR UPDATE',[row.email_normalized])).rows[0];
    const invited=(await client.query("SELECT 1 FROM account_email_invitations WHERE email_normalized=$1 AND status='pending' LIMIT 1",[row.email_normalized])).rows[0];
    if ((reserved && (reserved.user_id!==row.user_id || reserved.state!=='pending' || reserved.purpose!=='existing_user')) || invited) return {kind:'state' as const};
    const identity=reserved
      ? (await client.query<{id:number}>(`UPDATE account_email_identities SET email=$2,state='verified',verified_at=NOW(),updated_at=NOW() WHERE id=$1 AND user_id=$3 AND state='pending' AND purpose='existing_user' RETURNING id`,[reserved.id,row.email,row.user_id])).rows[0]
      : (await client.query<{id:number}>(`INSERT INTO account_email_identities (user_id,email,email_normalized,state,purpose,verified_at) VALUES ($1,$2,$3,'verified','existing_user',NOW()) ON CONFLICT (email_normalized) DO NOTHING RETURNING id`,[row.user_id,row.email,row.email_normalized])).rows[0];
    if (!identity) return {kind:'state' as const};
    // Supersede every older admin-issued link for this account, including links
    // to another pending address, before any can replace the newly verified email.
    await client.query("UPDATE account_email_verification_challenges SET status='superseded',superseded_at=NOW() WHERE user_id=$1 AND status='pending'",[row.user_id]);
    await client.query('UPDATE users SET primary_email_identity_id=$2 WHERE id=$1',[row.user_id,identity.id]);
    await client.query("UPDATE auth_login_email_enrollments SET status='consumed',consumed_at=NOW() WHERE id=$1",[row.id]);
    return {kind:'success' as const,payload:{userId:user.id,username:user.username,role:user.role,authEpoch:Number(user.auth_epoch)}};
  });
  if (result.kind==='missing') throw new LoginOtpNotFoundError('Pending enrollment not found');
  if (result.kind==='state') throw new LoginOtpStateError('Enrollment cannot be completed');
  if (result.kind==='invalid') { await audit((await queryOne<{user_id:number}>('SELECT user_id FROM auth_login_email_enrollments WHERE id=$1',[input.challengeId]))!.user_id,'login_email_enrollment_invalid','failure',input); throw new LoginOtpInvalidError('Invalid OTP'); }
  await audit(result.payload.userId,'login_email_enrollment_verified','success',input);
  return result.payload;
}
export async function cancelLoginEmailEnrollment(input:{challengeId:string}&Context) {
  const row=await queryOne<{user_id:number}>("UPDATE auth_login_email_enrollments SET status='cancelled' WHERE id=$1 AND status='pending' RETURNING user_id",[input.challengeId]);
  if (row) await audit(row.user_id,'login_email_enrollment_cancelled','success',input);
  return !!row;
}
export { AccountEmailValidationError };
