import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import bcrypt from 'bcryptjs';
import { Pool } from 'pg';

const name = `tower-otp-it-${process.pid}-${Date.now()}`;
let server: Server;
let base: string;
let pool: Pool;
let closePgPool: () => Promise<void>;
let resetProvider: () => void;
let outbox: Array<{ text: string }> = [];
let failDelivery = false;
let username: string;
const password = 'fixture-password-123';
let containerStarted = false;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeAll(async () => {
  // Never reuse a host or shared PostgreSQL instance. Docker chooses an ephemeral loopback port.
  docker('run', '-d', '--rm', '--pull=never', '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=otp_test', '-p', '127.0.0.1::5432', 'postgres:16-alpine');
  containerStarted = true;
  const binding = docker('port', name, '5432/tcp');
  const port = Number(binding.match(/:(\d+)$/)?.[1]);
  if (!Number.isSafeInteger(port) || port <= 0) throw new Error('Isolated PostgreSQL port missing');
  const url = `postgresql://postgres@127.0.0.1:${port}/otp_test`;
  if (new URL(url).pathname === new URL(process.env.DATABASE_URL || 'postgresql://localhost/tower_chat').pathname) throw new Error('Refusing shared database');
  process.env.DATABASE_URL = url;
  process.env.TOWER_LOGIN_EMAIL_OTP = 'off';
  process.env.TOWER_MAIL_PROVIDER = '';
  process.env.JWT_SECRET = 'isolated-otp-test-secret-must-not-be-used-elsewhere';
  const pg = await import('../../db/pg.js');
  closePgPool = pg.closePgPool;
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { await pg.getPgPool().query('SELECT 1'); ready = true; break; }
    catch { await new Promise(r => setTimeout(r, 300)); }
  }
  if (!ready) throw new Error('Isolated PostgreSQL did not start');
  await pg.initPg();
  pool = pg.getPgPool();
  const db = await pool.query('SELECT current_database() AS name, inet_server_port() AS port');
  if (db.rows[0].name !== 'otp_test' || Number(db.rows[0].port) !== 5432) throw new Error('DB identity mismatch');
  username = `otp-it-${process.pid}`;
  const user = (await pool.query('INSERT INTO users (username,password_hash,role,disabled,approval_status) VALUES ($1,$2,$3,0,$4) RETURNING id', [username, bcrypt.hashSync(password, 10), 'member', 'active'])).rows[0];
  const mail = await import('./mail/mail-service.js');
  resetProvider = mail.resetAccountMailProvider;
  mail.setAccountMailProvider({ name: 'capture', checkConnection: async () => ({ configured: true, connection: 'ok' }), send: async (message) => { if (failDelivery) throw new Error('fake delivery failure'); outbox.push({ text: message.text }); return { providerMessageId: 'fixture-id' }; } });
  const router = (await import('../../routes/api.js')).default;
  const app = express(); app.set('trust proxy', 1); app.use(express.json()); app.use('/api', router);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (globalThis as any).__otpFixtureUserId = user.id;
}, 120_000);

beforeEach(async () => {
  // Keep each scenario below the account-level 15-minute send quota.
  if (pool) {
    await pool.query("UPDATE auth_login_otp_challenges SET created_at=NOW()-INTERVAL '16 minutes' WHERE created_at > NOW()-INTERVAL '15 minutes'");
    outbox = [];
    process.env.TOWER_LOGIN_EMAIL_OTP = 'off';
    process.env.TOWER_LOGIN_EMAIL_OTP_PILOT_USER_IDS = '';
    process.env.TOWER_LOGIN_EMAIL_ENROLLMENT = 'off';
    process.env.TOWER_LOGIN_EMAIL_ENROLLMENT_MAX_USER_ID = '';
    process.env.TOWER_LOGIN_EMAIL_OTP_EXCLUDED_USER_IDS = '';
  }
});

afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (resetProvider) resetProvider();
  if (closePgPool) await closePgPool();
  if (containerStarted) docker('rm', '-f', '-v', name);
}, 30_000);

let requestIpCounter = 1;
async function post(path: string, payload: object) {
  // Express trusts one local proxy; give each test request a distinct synthetic client IP
  // so HTTP rate limiting does not mask the account-level OTP rules under test.
  const ip = `198.51.100.${requestIpCounter++ % 240 + 1}`;
  const response = await fetch(`${base}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(payload) });
  return { response, body: await response.json() };
}

// HTTP + isolated PostgreSQL + bcrypt cases can exceed Vitest's 5s default
// when the full preflight runs alongside other integration suites.
describe('isolated HTTP + PostgreSQL email OTP', () => {
  it('verifies email without approving a pending applicant, but activates admin-preapproved creation', async () => {
    const { registerExistingUserEmail, verifyExistingUserEmail, createAdminManagedAccount } = await import('./account-email-service.js');
    const actor = (globalThis as any).__otpFixtureUserId as number;
    const applicant = (await pool.query("INSERT INTO users (username,password_hash,role,disabled,approval_status) VALUES ($1,$2,'member',0,'pending') RETURNING id", [`applicant-${process.pid}`, bcrypt.hashSync(password,10)])).rows[0];
    let managedId: number | undefined;
    const verifyLatest = () => verifyExistingUserEmail(new URL(outbox.at(-1)!.text.match(/https?:\/\/\S+/)![0]).searchParams.get('accountEmailVerification')!);
    try {
      await registerExistingUserEmail({ userId: applicant.id, email: `applicant-${process.pid}@example.com`, actorUserId: actor });
      await verifyLatest();
      const row = (await pool.query('SELECT u.approval_status,i.state FROM users u JOIN account_email_identities i ON i.id=u.primary_email_identity_id WHERE u.id=$1', [applicant.id])).rows[0];
      expect(row).toMatchObject({ approval_status: 'pending', state: 'verified' });
      const managed = await createAdminManagedAccount({ username: `managed-${process.pid}`, password, passwordConfirm: password, role: 'member', displayName: 'Fixture', email: `managed-${process.pid}@example.com`, actorUserId: actor });
      managedId = managed.id;
      expect(managed.approval_status).toBe('pending');
      await verifyLatest();
      expect((await pool.query('SELECT approval_status,approved_by FROM users WHERE id=$1', [managedId])).rows[0]).toMatchObject({ approval_status: 'active', approved_by: actor });
    } finally {
      for (const id of [applicant.id, managedId].filter(Boolean)) {
        await pool.query('UPDATE users SET primary_email_identity_id=NULL WHERE id=$1', [id]);
        await pool.query('DELETE FROM account_email_identities WHERE user_id=$1', [id]);
        await pool.query('DELETE FROM users WHERE id=$1', [id]);
      }
    }
  });
  it('retries a cancelled address without duplicate key and rejects stale verification links', async () => {
    const mail = await import('./mail/mail-service.js');
    const { registerExistingUserEmail, cancelPendingExistingUserEmail, verifyExistingUserEmail, AccountEmailConflictError } = await import('./account-email-service.js');
    const id = (globalThis as any).__otpFixtureUserId as number;
    const address = `retry-${process.pid}@example.com`;
    const first = await registerExistingUserEmail({ userId: id, email: address, actorUserId: id });
    expect(first.emailStatus).toBe('pending');
    const firstToken = new URL(outbox.at(-1)!.text.match(/https?:\/\/\S+/)![0]).searchParams.get('accountEmailVerification')!;
    expect(await cancelPendingExistingUserEmail(id, id)).toBe(true);
    await registerExistingUserEmail({ userId: id, email: address, actorUserId: id });
    await expect(verifyExistingUserEmail(firstToken)).rejects.toThrow();
    const secondToken = new URL(outbox.at(-1)!.text.match(/https?:\/\/\S+/)![0]).searchParams.get('accountEmailVerification')!;
    expect((await pool.query('SELECT count(*)::int AS count FROM account_email_identities WHERE email_normalized=$1', [address])).rows[0].count).toBe(1);
    const other = (await pool.query("INSERT INTO users (username,password_hash,role,disabled,approval_status) VALUES ($1,$2,'member',0,'active') RETURNING id", [`other-${process.pid}`,bcrypt.hashSync(password,10)])).rows[0];
    await expect(registerExistingUserEmail({ userId: other.id, email: address, actorUserId: id })).rejects.toBeInstanceOf(AccountEmailConflictError);
    await verifyExistingUserEmail(secondToken);
    expect((await pool.query('SELECT state FROM account_email_identities WHERE email_normalized=$1', [address])).rows[0].state).toBe('verified');
    // Unconfigured provider must fail before creating a new identity.
    mail.resetAccountMailProvider();
    await expect(registerExistingUserEmail({ userId: other.id, email: `unready-${process.pid}@example.com`, actorUserId: id })).rejects.toThrow('Account mail provider is not ready');
    expect((await pool.query('SELECT count(*)::int AS count FROM account_email_identities WHERE user_id=$1', [other.id])).rows[0].count).toBe(0);
    await pool.query('DELETE FROM users WHERE id=$1', [other.id]);
    await pool.query('UPDATE users SET primary_email_identity_id=NULL WHERE id=$1', [id]);
    await pool.query('DELETE FROM account_email_identities WHERE email_normalized=$1', [address]);
    mail.setAccountMailProvider({ name: 'capture', checkConnection: async () => ({ configured: true, connection: 'ok' }), send: async message => { if (failDelivery) throw new Error('fake delivery failure'); outbox.push({text:message.text}); return {providerMessageId:'fixture-id'}; } });
  });
  it('preserves off login, blocks unready required login and issues a session only after fake mail OTP verification', async () => {
    const off = await post('/auth/login', { username, password });
    expect(off.response.status).toBe(200);
    expect(off.body.token).toBeTruthy();
    expect(off.response.headers.get('set-cookie')).toContain('tower_token=');
    expect(Number((await pool.query('SELECT count(*) AS count FROM auth_login_otp_challenges')).rows[0].count)).toBe(0);

    process.env.TOWER_LOGIN_EMAIL_OTP = 'required';
    const blocked = await post('/auth/login', { username, password });
    expect(blocked.response.status).toBe(503);
    expect(blocked.body.token).toBeUndefined();
    expect(blocked.response.headers.get('set-cookie')).toBeNull();

    const id = (globalThis as any).__otpFixtureUserId;
    const identity = (await pool.query("INSERT INTO account_email_identities (user_id,email,email_normalized,state,purpose,verified_at) VALUES ($1,'fixture@example.com','fixture@example.com','verified','existing_user',NOW()) RETURNING id", [id])).rows[0];
    await pool.query('UPDATE users SET primary_email_identity_id=$1 WHERE id=$2', [identity.id, id]);
    const challenge = await post('/auth/login', { username, password });
    expect(challenge.response.status).toBe(202);
    expect(challenge.body.otpRequired).toBe(true);
    expect(challenge.body.token).toBeUndefined();
    expect(challenge.response.headers.get('set-cookie')).toBeNull();
    expect(outbox).toHaveLength(1);
    const row = (await pool.query('SELECT otp_hash,status FROM auth_login_otp_challenges WHERE id=$1', [challenge.body.challengeId])).rows[0];
    expect(row.status).toBe('pending');
    const otp = outbox[0].text.match(/\b\d{6}\b/)?.[0];
    expect(otp).toBeDefined();
    expect(row.otp_hash).not.toContain(otp);
    const verified = await post('/auth/login/otp/verify', { challengeId: challenge.body.challengeId, otp });
    expect(verified.response.status).toBe(200);
    expect(verified.body.token).toBeTruthy();
    expect(verified.response.headers.get('set-cookie')).toContain('tower_token=');
    expect((await pool.query('SELECT status FROM auth_login_otp_challenges WHERE id=$1', [challenge.body.challengeId])).rows[0].status).toBe('consumed');
    const reused = await post('/auth/login/otp/verify', { challengeId: challenge.body.challengeId, otp });
    expect(reused.response.status).toBe(404);
    expect(reused.response.headers.get('set-cookie')).toBeNull();
  });

  it('pilots only one existing user, fails closed until email verification, then rolls back to password login', async () => {
    process.env.TOWER_LOGIN_EMAIL_OTP = 'off';
    const pilotName = `otp-pilot-${process.pid}`;
    const pilotId = (await pool.query('INSERT INTO users (username,password_hash,role,disabled,approval_status) VALUES ($1,$2,$3,0,$4) RETURNING id', [pilotName, bcrypt.hashSync(password, 10), 'member', 'active'])).rows[0].id as number;
    const otherName = `otp-other-${process.pid}`;
    await pool.query('INSERT INTO users (username,password_hash,role,disabled,approval_status) VALUES ($1,$2,$3,0,$4)', [otherName, bcrypt.hashSync(password, 10), 'member', 'active']);
    process.env.TOWER_LOGIN_EMAIL_OTP_PILOT_USER_IDS = String(pilotId);
    try {
      const other = await post('/auth/login', { username: otherName, password });
      expect(other.response.status).toBe(200);
      expect(other.body.token).toBeTruthy();
      const blocked = await post('/auth/login', { username: pilotName, password });
      expect(blocked.response.status).toBe(503);
      expect(blocked.body.token).toBeUndefined();
      expect(blocked.response.headers.get('set-cookie')).toBeNull();
      const identity = (await pool.query("INSERT INTO account_email_identities (user_id,email,email_normalized,state,purpose) VALUES ($1,'pilot@example.com','pilot@example.com','pending','existing_user') RETURNING id", [pilotId])).rows[0];
      const stillBlocked = await post('/auth/login', { username: pilotName, password });
      expect(stillBlocked.response.status).toBe(503);
      await pool.query("UPDATE account_email_identities SET state='verified',verified_at=NOW() WHERE id=$1", [identity.id]);
      await pool.query('UPDATE users SET primary_email_identity_id=$1 WHERE id=$2', [identity.id, pilotId]);
      const challenge = await post('/auth/login', { username: pilotName, password });
      expect(challenge.response.status).toBe(202);
      expect(challenge.body.token).toBeUndefined();
      const otp = outbox.at(-1)?.text.match(/\b\d{6}\b/)?.[0];
      const verified = await post('/auth/login/otp/verify', { challengeId: challenge.body.challengeId, otp });
      expect(verified.response.status).toBe(200);
      expect(verified.body.token).toBeTruthy();
      const pending = await post('/auth/login', { username: pilotName, password });
      expect(pending.response.status).toBe(202);
      process.env.TOWER_LOGIN_EMAIL_OTP_PILOT_USER_IDS = '';
      const noLongerRequired = await post('/auth/login/otp/verify', { challengeId: pending.body.challengeId, otp: outbox.at(-1)?.text.match(/\b\d{6}\b/)?.[0] });
      expect(noLongerRequired.response.status).toBe(410);
      expect(noLongerRequired.response.headers.get('set-cookie')).toBeNull();
      const rolledBack = await post('/auth/login', { username: pilotName, password });
      expect(rolledBack.response.status).toBe(200);
      expect(rolledBack.body.token).toBeTruthy();
    } finally { process.env.TOWER_LOGIN_EMAIL_OTP_PILOT_USER_IDS = ''; }
  }, 30_000);

  it('enforces resend cooldown, supersedes old codes, and supports cancellation', async () => {
    process.env.TOWER_LOGIN_EMAIL_OTP_PILOT_USER_IDS = String((globalThis as any).__otpFixtureUserId);
    const first = await post('/auth/login', { username, password });
    expect(first.response.status).toBe(202);
    const early = await post('/auth/login/otp/resend', { challengeId: first.body.challengeId });
    expect(early.response.status).toBe(429);
    expect(early.body.token).toBeUndefined();
    expect(early.response.headers.get('set-cookie')).toBeNull();
    await pool.query("UPDATE auth_login_otp_challenges SET resend_available_at=NOW()-INTERVAL '1 second' WHERE id=$1", [first.body.challengeId]);
    const second = await post('/auth/login/otp/resend', { challengeId: first.body.challengeId });
    expect(second.response.status).toBe(202);
    expect(second.body.challengeId).not.toBe(first.body.challengeId);
    expect((await pool.query('SELECT status FROM auth_login_otp_challenges WHERE id=$1', [first.body.challengeId])).rows[0].status).toBe('superseded');
    const oldCode = outbox.at(-2)?.text.match(/\b\d{6}\b/)?.[0];
    const oldVerify = await post('/auth/login/otp/verify', { challengeId: first.body.challengeId, otp: oldCode });
    expect(oldVerify.response.status).toBe(404);
    expect(oldVerify.response.headers.get('set-cookie')).toBeNull();
    const cancelled = await post('/auth/login/otp/cancel', { challengeId: second.body.challengeId });
    expect(cancelled.response.status).toBe(200);
    const cancelledVerify = await post('/auth/login/otp/verify', { challengeId: second.body.challengeId, otp: outbox.at(-1)?.text.match(/\b\d{6}\b/)?.[0] });
    expect(cancelledVerify.response.status).toBe(404);
    expect(cancelledVerify.response.headers.get('set-cookie')).toBeNull();
  }, 30_000);

  it('expires a challenge and locks it after five incorrect codes', async () => {
    process.env.TOWER_LOGIN_EMAIL_OTP_PILOT_USER_IDS = String((globalThis as any).__otpFixtureUserId);
    const expiring = await post('/auth/login', { username, password });
    expect(expiring.response.status).toBe(202);
    await pool.query("UPDATE auth_login_otp_challenges SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [expiring.body.challengeId]);
    const expired = await post('/auth/login/otp/verify', { challengeId: expiring.body.challengeId, otp: outbox.at(-1)?.text.match(/\b\d{6}\b/)?.[0] });
    expect(expired.response.status).toBe(410);
    expect(expired.response.headers.get('set-cookie')).toBeNull();
    expect((await pool.query('SELECT status FROM auth_login_otp_challenges WHERE id=$1', [expiring.body.challengeId])).rows[0].status).toBe('expired');

    const next = await post('/auth/login', { username, password });
    expect(next.response.status).toBe(202);
    const correct = outbox.at(-1)?.text.match(/\b\d{6}\b/)?.[0];
    const wrong = correct === '000000' ? '999999' : '000000';
    for (let attempt = 1; attempt <= 5; attempt++) {
      const invalid = await post('/auth/login/otp/verify', { challengeId: next.body.challengeId, otp: wrong });
      expect(invalid.response.status).toBe(401);
      expect(invalid.body.token).toBeUndefined();
      expect(invalid.response.headers.get('set-cookie')).toBeNull();
      const row = (await pool.query('SELECT status,failed_attempts FROM auth_login_otp_challenges WHERE id=$1', [next.body.challengeId])).rows[0];
      expect(row.failed_attempts).toBe(attempt);
      expect(row.status).toBe(attempt === 5 ? 'attempts_exceeded' : 'pending');
    }
    const locked = await post('/auth/login/otp/verify', { challengeId: next.body.challengeId, otp: correct });
    expect(locked.response.status).toBe(404);
    expect(locked.response.headers.get('set-cookie')).toBeNull();
  });

  it('fails closed on delivery error and recovers with a new challenge', async () => {
    process.env.TOWER_LOGIN_EMAIL_OTP_PILOT_USER_IDS = String((globalThis as any).__otpFixtureUserId);
    failDelivery = true;
    try {
      const failed = await post('/auth/login', { username, password });
      expect(failed.response.status).toBe(503);
      expect(failed.body.token).toBeUndefined();
      expect(failed.response.headers.get('set-cookie')).toBeNull();
      expect((await pool.query("SELECT status FROM auth_login_otp_challenges WHERE status='delivery_failed' ORDER BY created_at DESC LIMIT 1")).rows[0].status).toBe('delivery_failed');
    } finally { failDelivery = false; }
    const recovered = await post('/auth/login', { username, password });
    expect(recovered.response.status).toBe(202);
    expect(recovered.response.headers.get('set-cookie')).toBeNull();
    expect((await pool.query('SELECT status FROM auth_login_otp_challenges WHERE id=$1', [recovered.body.challengeId])).rows[0].status).toBe('pending');
  });
});

describe('isolated existing-account email enrollment', () => {
  const fixtureId = () => (globalThis as any).__otpFixtureUserId as number;
  const code = () => outbox.at(-1)!.text.match(/\b\d{6}\b/)![0];
  beforeEach(async () => {
    process.env.TOWER_LOGIN_EMAIL_OTP='required';
    process.env.TOWER_LOGIN_EMAIL_ENROLLMENT='existing';
    process.env.TOWER_LOGIN_EMAIL_ENROLLMENT_MAX_USER_ID=String((await pool.query('SELECT MAX(id) AS id FROM users')).rows[0].id);
    process.env.TOWER_LOGIN_EMAIL_OTP_EXCLUDED_USER_IDS='';
    await pool.query('UPDATE users SET primary_email_identity_id=NULL WHERE id=$1',[fixtureId()]);
    await pool.query('DELETE FROM auth_login_otp_challenges WHERE user_id=$1',[fixtureId()]);
    await pool.query('DELETE FROM account_email_identities WHERE user_id=$1',[fixtureId()]);
    await pool.query("UPDATE auth_login_email_enrollments SET created_at=NOW()-INTERVAL '16 minutes',status='cancelled' WHERE user_id=$1 AND status='pending'",[fixtureId()]);
    await pool.query("UPDATE auth_login_email_enrollments SET created_at=NOW()-INTERVAL '16 minutes',resend_available_at=NOW()-INTERVAL '1 second' WHERE user_id=$1",[fixtureId()]);
  });
  it('keeps session withheld until registration is verified; subsequent login requires ordinary OTP', async () => {
    const start=await post('/auth/login',{username,password});
    expect(start.response.status).toBe(202);
    expect(start.body).toMatchObject({enrollmentRequired:true,emailRequired:true});
    expect(start.body.token).toBeUndefined();
    expect(start.response.headers.get('set-cookie')).toBeNull();
    expect(outbox).toHaveLength(0);
    const address=`enroll-${process.pid}@example.com`;
    const sent=await post('/auth/login/enrollment/email',{challengeId:start.body.challengeId,email:address});
    expect(sent.response.status).toBe(202);
    expect(sent.body.enrollmentRequired).toBe(true);
    const row=(await pool.query('SELECT otp_hash FROM auth_login_email_enrollments WHERE id=$1',[sent.body.challengeId])).rows[0];
    expect(row.otp_hash).not.toContain(code());
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM account_email_identities WHERE user_id=$1',[fixtureId()])).rows[0].n).toBe(0);
    const early=await post('/auth/login/enrollment/resend',{challengeId:sent.body.challengeId});
    expect(early.response.status).toBe(429);
    const wrong=await post('/auth/login/enrollment/verify',{challengeId:sent.body.challengeId,otp:'000000'});
    expect(wrong.response.status).toBe(401);
    const verified=await post('/auth/login/enrollment/verify',{challengeId:sent.body.challengeId,otp:code()});
    expect(verified.response.status).toBe(200);
    expect(verified.body.token).toBeTruthy();
    expect(verified.response.headers.get('set-cookie')).toContain('tower_token=');
    expect((await pool.query('SELECT i.state FROM users u JOIN account_email_identities i ON i.id=u.primary_email_identity_id WHERE u.id=$1',[fixtureId()])).rows[0].state).toBe('verified');
    expect((await post('/auth/login/enrollment/verify',{challengeId:sent.body.challengeId,otp:code()})).response.status).toBe(404);
    const next=await post('/auth/login',{username,password});
    expect(next.body.otpRequired).toBe(true);
    expect(next.body.enrollmentRequired).toBeUndefined();
    expect(next.response.headers.get('set-cookie')).toBeNull();
  });
  it('blocks pending, disabled, duplicate email, password change, cancellation, expiration and failed delivery',async()=>{
    const pendingName=`pending-enroll-${process.pid}`;
    await pool.query("INSERT INTO users (username,password_hash,role,disabled,approval_status) VALUES ($1,$2,'member',0,'pending')",[pendingName,bcrypt.hashSync(password,10)]);
    expect((await post('/auth/login',{username:pendingName,password})).response.status).toBe(403);
    const start=await post('/auth/login',{username,password});
    const address=`safety-enroll-${process.pid}@example.com`;
    const sent=await post('/auth/login/enrollment/email',{challengeId:start.body.challengeId,email:address});
    const otp=code();
    await pool.query('UPDATE users SET password_changed_at=NOW() WHERE id=$1',[fixtureId()]);
    expect((await post('/auth/login/enrollment/verify',{challengeId:sent.body.challengeId,otp})).response.status).toBe(410);
    await pool.query("UPDATE auth_login_email_enrollments SET resend_available_at=NOW()-INTERVAL '1 second' WHERE user_id=$1",[fixtureId()]);
    const fresh=await post('/auth/login',{username,password});
    const duplicate=`duplicate-enroll-${process.pid}@example.com`;
    await pool.query("INSERT INTO account_email_identities (user_id,email,email_normalized,state,purpose) VALUES ($1,$2,$2,'cancelled','existing_user')",[fixtureId(),duplicate]);
    expect((await post('/auth/login/enrollment/email',{challengeId:fresh.body.challengeId,email:duplicate})).response.status).toBe(410);
    await pool.query('DELETE FROM account_email_identities WHERE email_normalized=$1',[duplicate]);
    expect((await post('/auth/login/enrollment/cancel',{challengeId:fresh.body.challengeId})).response.status).toBe(200);
    expect((await post('/auth/login/enrollment/email',{challengeId:fresh.body.challengeId,email:address})).response.status).toBe(404);
    const expiring=await post('/auth/login',{username,password});
    await pool.query("UPDATE auth_login_email_enrollments SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[expiring.body.challengeId]);
    expect((await post('/auth/login/enrollment/email',{challengeId:expiring.body.challengeId,email:address})).response.status).toBe(410);
    await pool.query("UPDATE auth_login_email_enrollments SET resend_available_at=NOW()-INTERVAL '1 second' WHERE user_id=$1",[fixtureId()]);
    const delivery=await post('/auth/login',{username,password});
    failDelivery=true;
    try {expect((await post('/auth/login/enrollment/email',{challengeId:delivery.body.challengeId,email:address})).response.status).toBe(503);} finally {failDelivery=false;}
    await pool.query("UPDATE auth_login_email_enrollments SET resend_available_at=NOW()-INTERVAL '1 second' WHERE user_id=$1",[fixtureId()]);
    const retry=await post('/auth/login',{username,password});
    expect((await post('/auth/login/enrollment/email',{challengeId:retry.body.challengeId,email:address})).response.status).toBe(202);
    await pool.query('UPDATE users SET disabled=1 WHERE id=$1',[fixtureId()]);
    expect((await post('/auth/login/enrollment/verify',{challengeId:outbox.length ? (await pool.query("SELECT id FROM auth_login_email_enrollments WHERE user_id=$1 AND status='pending'",[fixtureId()])).rows[0].id : '',otp:code()})).response.status).toBe(410);
    await pool.query('UPDATE users SET disabled=0 WHERE id=$1',[fixtureId()]);
  }, 30_000);
  it('reuses only the owner pending identity, resends a new code and invalidates the admin link',async()=>{
    const id=fixtureId();
    const address=`reserved-${process.pid}@example.com`;
    const { registerExistingUserEmail, verifyExistingUserEmail }=await import('./account-email-service.js');
    await registerExistingUserEmail({userId:id,email:address,actorUserId:id});
    const link=new URL(outbox.at(-1)!.text.match(/https?:\/\/\S+/)![0]).searchParams.get('accountEmailVerification')!;
    const reservedId=(await pool.query('SELECT id FROM account_email_identities WHERE email_normalized=$1',[address])).rows[0].id;
    const start=await post('/auth/login',{username,password});
    const first=await post('/auth/login/enrollment/email',{challengeId:start.body.challengeId,email:address.toUpperCase()});
    expect(first.response.status).toBe(202);
    expect((await pool.query('SELECT state FROM account_email_identities WHERE id=$1',[reservedId])).rows[0].state).toBe('pending');
    const oldCode=code();
    await pool.query("UPDATE auth_login_email_enrollments SET resend_available_at=NOW()-INTERVAL '1 second' WHERE id=$1",[first.body.challengeId]);
    const resent=await post('/auth/login/enrollment/resend',{challengeId:first.body.challengeId});
    expect(resent.response.status).toBe(202);
    expect(resent.body.challengeId).not.toBe(first.body.challengeId);
    expect((await post('/auth/login/enrollment/verify',{challengeId:first.body.challengeId,otp:oldCode})).response.status).toBe(404);
    const verified=await post('/auth/login/enrollment/verify',{challengeId:resent.body.challengeId,otp:code()});
    expect(verified.response.status).toBe(200);
    expect(verified.body.token).toBeTruthy();
    expect((await pool.query('SELECT id,state FROM account_email_identities WHERE email_normalized=$1',[address])).rows[0]).toMatchObject({id:reservedId,state:'verified'});
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM account_email_identities WHERE user_id=$1',[id])).rows[0].n).toBe(1);
    expect((await pool.query("SELECT status FROM account_email_verification_challenges WHERE email_identity_id=$1",[reservedId])).rows[0].status).toBe('superseded');
    await expect(verifyExistingUserEmail(link)).rejects.toThrow();
    expect((await post('/auth/login/enrollment/verify',{challengeId:resent.body.challengeId,otp:code()})).response.status).toBe(404);
  }, 30_000);
  it('rejects a sent code after an administrator verifies a different address',async()=>{
    const id=fixtureId();
    const draft=await post('/auth/login',{username,password});
    const sent=await post('/auth/login/enrollment/email',{challengeId:draft.body.challengeId,email:`user-choice-${process.pid}@example.com`});
    expect(sent.response.status).toBe(202);
    const otp=code();
    const {registerExistingUserEmail,verifyExistingUserEmail}=await import('./account-email-service.js');
    await registerExistingUserEmail({userId:id,email:`admin-choice-${process.pid}@example.com`,actorUserId:id});
    const link=new URL(outbox.at(-1)!.text.match(/https?:\/\/\S+/)![0]).searchParams.get('accountEmailVerification')!;
    await verifyExistingUserEmail(link);
    expect((await post('/auth/login/enrollment/verify',{challengeId:sent.body.challengeId,otp})).response.status).toBe(410);
    expect((await pool.query('SELECT i.email_normalized FROM users u JOIN account_email_identities i ON i.id=u.primary_email_identity_id WHERE u.id=$1',[id])).rows[0].email_normalized).toBe(`admin-choice-${process.pid}@example.com`);
  });
  it('serializes administrator link verification against enrollment OTP consumption',async()=>{
    const id=fixtureId(), address=`admin-race-${process.pid}@example.com`;
    const {registerExistingUserEmail,verifyExistingUserEmail}=await import('./account-email-service.js');
    await registerExistingUserEmail({userId:id,email:address,actorUserId:id});
    const link=new URL(outbox.at(-1)!.text.match(/https?:\/\/\S+/)![0]).searchParams.get('accountEmailVerification')!;
    const draft=await post('/auth/login',{username,password});
    const sent=await post('/auth/login/enrollment/email',{challengeId:draft.body.challengeId,email:address});
    const otp=code();
    const outcomes=await Promise.allSettled([verifyExistingUserEmail(link),post('/auth/login/enrollment/verify',{challengeId:sent.body.challengeId,otp})]);
    const adminWon=outcomes[0].status==='fulfilled';
    const enrollment=outcomes[1].status==='fulfilled'?outcomes[1].value:undefined;
    expect([adminWon,enrollment?.response.status===200].filter(Boolean)).toHaveLength(1);
    if (adminWon) expect(enrollment?.response.status).toBe(410);
    else expect(outcomes[0].status).toBe('rejected');
    const primary=(await pool.query('SELECT i.state,i.user_id FROM users u JOIN account_email_identities i ON i.id=u.primary_email_identity_id WHERE u.id=$1',[id])).rows[0];
    expect(primary).toMatchObject({state:'verified',user_id:id});
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM account_email_identities WHERE user_id=$1 AND state='verified'",[id])).rows[0].n).toBe(1);
  });
  it('requires fresh password authentication after an expired code while leaving the pending reservation',async()=>{
    const id=fixtureId(), address=`renew-${process.pid}@example.com`;
    const {registerExistingUserEmail}=await import('./account-email-service.js');
    await registerExistingUserEmail({userId:id,email:address,actorUserId:id});
    const draft=await post('/auth/login',{username,password});
    const sent=await post('/auth/login/enrollment/email',{challengeId:draft.body.challengeId,email:address});
    expect(sent.response.status).toBe(202);
    const expiredCode=code();
    await pool.query("UPDATE auth_login_email_enrollments SET expires_at=NOW()-INTERVAL '1 second',resend_available_at=NOW()-INTERVAL '1 second' WHERE id=$1",[sent.body.challengeId]);
    expect((await post('/auth/login/enrollment/verify',{challengeId:sent.body.challengeId,otp:expiredCode})).response.status).toBe(410);
    expect((await post('/auth/login/enrollment/resend',{challengeId:sent.body.challengeId})).response.status).toBe(404);
    const fresh=await post('/auth/login',{username,password});
    const renewed=await post('/auth/login/enrollment/email',{challengeId:fresh.body.challengeId,email:address});
    expect(renewed.response.status).toBe(202);
    expect((await post('/auth/login/enrollment/verify',{challengeId:renewed.body.challengeId,otp:expiredCode})).response.status).toBe(401);
    expect((await post('/auth/login/enrollment/verify',{challengeId:renewed.body.challengeId,otp:code()})).response.status).toBe(200);
  });
  it('rejects other-owner reservations, pending invitations and non-pending identity states',async()=>{
    const id=fixtureId(), other=(await pool.query("INSERT INTO users (username,password_hash,role,disabled,approval_status) VALUES ($1,$2,'member',0,'active') RETURNING id",[`reserved-other-${process.pid}`,bcrypt.hashSync(password,10)])).rows[0].id;
    const cases:[string,number,string,string][]=[
      ['other',other,'pending','existing_user'],['verified',id,'verified','existing_user'],
      ['superseded',id,'superseded','existing_user'],['cancelled',id,'cancelled','existing_user'],
      ['change',id,'pending','change'],['invite',id,'pending','invite'],
    ];
    for (const [suffix,owner,state,purpose] of cases) {
      const address=`reserved-${suffix}-${process.pid}@example.com`;
      const draft=await post('/auth/login',{username,password});
      expect(draft.body.emailRequired).toBe(true);
      await pool.query(`INSERT INTO account_email_identities (user_id,email,email_normalized,state,purpose${state==='verified'?',verified_at':''}) VALUES ($1,$2,$2,$3,$4${state==='verified'?',NOW()':''})`,[owner,address,state,purpose]);
      expect((await post('/auth/login/enrollment/email',{challengeId:draft.body.challengeId,email:address})).response.status).toBe(410);
      await pool.query('DELETE FROM account_email_identities WHERE email_normalized=$1',[address]);
    }
    const invited=`invited-${process.pid}@example.com`;
    await pool.query("INSERT INTO account_email_invitations (email,email_normalized,token_hash,status,expires_at) VALUES ($1,$1,$2,'pending',NOW()+INTERVAL '1 hour')",[invited,`fixture-invited-${process.pid}`]);
    const draft=await post('/auth/login',{username,password});
    expect((await post('/auth/login/enrollment/email',{challengeId:draft.body.challengeId,email:invited})).response.status).toBe(410);
    const both=`both-reserved-${process.pid}@example.com`;
    const ownDraft=await post('/auth/login',{username,password});
    await pool.query("INSERT INTO account_email_identities (user_id,email,email_normalized,state,purpose) VALUES ($1,$2,$2,'pending','existing_user')",[id,both]);
    await pool.query("INSERT INTO account_email_invitations (email,email_normalized,token_hash,status,expires_at) VALUES ($1,$1,$2,'pending',NOW()+INTERVAL '1 hour')",[both,`fixture-both-${process.pid}`]);
    expect((await post('/auth/login/enrollment/email',{challengeId:ownDraft.body.challengeId,email:both})).response.status).toBe(410);
  });
  it('rejects an enrollment after the authentication epoch advances without changing the password timestamp',async()=>{
    const id=fixtureId();
    const draft=await post('/auth/login',{username,password});
    const sent=await post('/auth/login/enrollment/email',{challengeId:draft.body.challengeId,email:`epoch-${process.pid}@example.com`});
    expect(sent.response.status).toBe(202);
    await pool.query('UPDATE users SET auth_epoch=auth_epoch+1 WHERE id=$1',[id]);
    expect((await post('/auth/login/enrollment/verify',{challengeId:sent.body.challengeId,otp:code()})).response.status).toBe(410);
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM account_email_identities WHERE user_id=$1 AND state='verified'",[id])).rows[0].n).toBe(0);
  });
  it('caps attempts, supersedes old codes and limits account-wide sends',async()=>{
    const address=`quota-enroll-${process.pid}@example.com`;
    const start=await post('/auth/login',{username,password});
    const first=await post('/auth/login/enrollment/email',{challengeId:start.body.challengeId,email:address});
    const old=code();
    await pool.query("UPDATE auth_login_email_enrollments SET resend_available_at=NOW()-INTERVAL '1 second' WHERE id=$1",[first.body.challengeId]);
    const second=await post('/auth/login/enrollment/resend',{challengeId:first.body.challengeId});
    expect(second.response.status).toBe(202);
    expect((await post('/auth/login/enrollment/verify',{challengeId:first.body.challengeId,otp:old})).response.status).toBe(404);
    for (let i=0;i<5;i++) expect((await post('/auth/login/enrollment/verify',{challengeId:second.body.challengeId,otp:'000000'})).response.status).toBe(401);
    expect((await post('/auth/login/enrollment/verify',{challengeId:second.body.challengeId,otp:code()})).response.status).toBe(404);
    for(let i=0;i<3;i++) {
      await pool.query("UPDATE auth_login_email_enrollments SET resend_available_at=NOW()-INTERVAL '1 second' WHERE user_id=$1",[fixtureId()]);
      const next=await post('/auth/login',{username,password});
      const sent=await post('/auth/login/enrollment/email',{challengeId:next.body.challengeId,email:address});
      expect(sent.response.status).toBe(202);
    }
    await pool.query("UPDATE auth_login_email_enrollments SET resend_available_at=NOW()-INTERVAL '1 second' WHERE user_id=$1",[fixtureId()]);
    const last=await post('/auth/login',{username,password});
    expect((await post('/auth/login/enrollment/email',{challengeId:last.body.challengeId,email:address})).response.status).toBe(429);
  });
});

describe('isolated enrollment concurrency and boundary regressions',()=>{
  it('serializes concurrent enrollment submissions and code consumption without overwriting verified email',async()=>{
    const id=(globalThis as any).__otpFixtureUserId as number;
    await pool.query('DELETE FROM auth_login_otp_challenges WHERE user_id=$1',[id]);
    await pool.query('UPDATE users SET primary_email_identity_id=NULL WHERE id=$1',[id]);
    await pool.query('DELETE FROM account_email_identities WHERE user_id=$1',[id]);
    await pool.query("UPDATE auth_login_email_enrollments SET created_at=NOW()-INTERVAL '16 minutes',resend_available_at=NOW()-INTERVAL '1 second' WHERE user_id=$1",[id]);
    process.env.TOWER_LOGIN_EMAIL_OTP='required';
    process.env.TOWER_LOGIN_EMAIL_ENROLLMENT='existing';
    process.env.TOWER_LOGIN_EMAIL_ENROLLMENT_MAX_USER_ID=String((await pool.query('SELECT MAX(id) AS id FROM users')).rows[0].id);
    const start=await post('/auth/login',{username,password});
    const submissions=await Promise.all([post('/auth/login/enrollment/email',{challengeId:start.body.challengeId,email:`race-a-${process.pid}@example.com`}),post('/auth/login/enrollment/email',{challengeId:start.body.challengeId,email:`race-b-${process.pid}@example.com`})]);
    expect(submissions.map(r=>r.response.status).sort()).toEqual([202,404]);
    const sent=submissions.find(r=>r.response.status===202)!;
    const otp=outbox.at(-1)!.text.match(/\b\d{6}\b/)![0];
    const verified=await Promise.all([post('/auth/login/enrollment/verify',{challengeId:sent.body.challengeId,otp}),post('/auth/login/enrollment/verify',{challengeId:sent.body.challengeId,otp})]);
    expect(verified.map(r=>r.response.status).sort()).toEqual([200,404]);
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM account_email_identities WHERE user_id=$1 AND state='verified'",[id])).rows[0].n).toBe(1);
    const ordinary=await post('/auth/login',{username,password});
    expect(ordinary.body.otpRequired).toBe(true);
    expect((await post('/auth/login/enrollment/email',{challengeId:ordinary.body.challengeId,email:'overwrite@example.com'})).response.status).toBe(404);
  });
  it('rejects outside-cutoff, rejected, invalid-password and malformed challenges and respects explicit exclusions',async()=>{
    process.env.TOWER_LOGIN_EMAIL_OTP='required';process.env.TOWER_LOGIN_EMAIL_ENROLLMENT='existing';
    const id=(globalThis as any).__otpFixtureUserId as number;
    const outsiderName=`cutoff-${process.pid}`;
    const outsider=(await pool.query("INSERT INTO users (username,password_hash,role,disabled,approval_status) VALUES ($1,$2,'member',0,'active') RETURNING id",[outsiderName,bcrypt.hashSync(password,10)])).rows[0];
    process.env.TOWER_LOGIN_EMAIL_ENROLLMENT_MAX_USER_ID=String(outsider.id-1);
    expect((await post('/auth/login',{username:outsiderName,password})).response.status).toBe(503);
    expect((await post('/auth/login',{username:outsiderName,password:'wrong'})).response.status).toBe(401);
    await pool.query("UPDATE users SET approval_status='rejected' WHERE id=$1",[outsider.id]);
    expect((await post('/auth/login',{username:outsiderName,password})).response.status).toBe(403);
    expect((await post('/auth/login/enrollment/email',{challengeId:'not-a-uuid',email:'x@example.com'})).response.status).toBe(400);
    process.env.TOWER_LOGIN_EMAIL_OTP_EXCLUDED_USER_IDS=String(id);
    const excluded=await post('/auth/login',{username,password});
    expect(excluded.response.status).toBe(200);expect(excluded.body.token).toBeTruthy();
    process.env.TOWER_LOGIN_EMAIL_OTP_EXCLUDED_USER_IDS='';
  });

  it('allows only one account to consume the same email and revalidates cutover and code expiry',async()=>{
    const create=async(suffix:string)=> (await pool.query("INSERT INTO users (username,password_hash,role,disabled,approval_status) VALUES ($1,$2,'member',0,'active') RETURNING id,username",[`same-mail-${suffix}-${process.pid}`,bcrypt.hashSync(password,10)])).rows[0];
    const a=await create('a'),b=await create('b');
    process.env.TOWER_LOGIN_EMAIL_OTP='off';process.env.TOWER_LOGIN_EMAIL_OTP_PILOT_USER_IDS=`${a.id},${b.id}`;
    process.env.TOWER_LOGIN_EMAIL_ENROLLMENT='existing';process.env.TOWER_LOGIN_EMAIL_ENROLLMENT_MAX_USER_ID=String(b.id);
    const draftA=await post('/auth/login',{username:a.username,password});
    const draftB=await post('/auth/login',{username:b.username,password});
    const address=`same-mail-${process.pid}@example.com`;
    const sentA=await post('/auth/login/enrollment/email',{challengeId:draftA.body.challengeId,email:address});
    const otpA=outbox.at(-1)!.text.match(/\b\d{6}\b/)![0];
    const sentB=await post('/auth/login/enrollment/email',{challengeId:draftB.body.challengeId,email:address});
    const otpB=outbox.at(-1)!.text.match(/\b\d{6}\b/)![0];
    const results=await Promise.all([post('/auth/login/enrollment/verify',{challengeId:sentA.body.challengeId,otp:otpA}),post('/auth/login/enrollment/verify',{challengeId:sentB.body.challengeId,otp:otpB})]);
    expect(results.map(r=>r.response.status).sort()).toEqual([200,410]);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM account_email_identities WHERE email_normalized=$1',[address])).rows[0].n).toBe(1);
    const loser=results[0].response.status===410?a:b;
    await pool.query("UPDATE auth_login_email_enrollments SET resend_available_at=NOW()-INTERVAL '1 second' WHERE user_id=$1",[loser.id]);
    const next=await post('/auth/login',{username:loser.username,password});
    const nextSent=await post('/auth/login/enrollment/email',{challengeId:next.body.challengeId,email:`expired-mail-${process.pid}@example.com`});
    await pool.query("UPDATE auth_login_email_enrollments SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[nextSent.body.challengeId]);
    expect((await post('/auth/login/enrollment/verify',{challengeId:nextSent.body.challengeId,otp:outbox.at(-1)!.text.match(/\b\d{6}\b/)![0]})).response.status).toBe(410);
    await pool.query("UPDATE auth_login_email_enrollments SET resend_available_at=NOW()-INTERVAL '1 second' WHERE user_id=$1",[loser.id]);
    const cutover=await post('/auth/login',{username:loser.username,password});
    const cutoverSent=await post('/auth/login/enrollment/email',{challengeId:cutover.body.challengeId,email:`cutover-mail-${process.pid}@example.com`});
    process.env.TOWER_LOGIN_EMAIL_ENROLLMENT='off';
    expect((await post('/auth/login/enrollment/verify',{challengeId:cutoverSent.body.challengeId,otp:outbox.at(-1)!.text.match(/\b\d{6}\b/)![0]})).response.status).toBe(410);
  });

});


describe('isolated account invitation cancellation HTTP contract', () => {
  it('cancels a pending invitation, audits it, and rejects its token on inspect and accept', async () => {
    const { generateToken } = await import('../auth/auth');
    const { createAccountEmailInvitation } = await import('./account-email-service');
    const actor = (await pool.query("INSERT INTO users (username,password_hash,role,approval_status) VALUES ($1,$2,'admin','active') RETURNING id", [`invite-admin-${process.pid}`, bcrypt.hashSync(password, 4)])).rows[0];
    const token = generateToken({ userId: actor.id, username: `invite-admin-${process.pid}`, role: 'admin' });
    const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const invitation = await createAccountEmailInvitation({ email: 'invitee@example.com', role: 'member', actorUserId: actor.id });
    const link = new URL(outbox.at(-1)!.text.match(/https?:\/\/\S+/)![0]);
    const inviteToken = link.searchParams.get('accountInvitation')!;
    expect(inviteToken).toBeTruthy();
    const endpoint = `${base}/api/admin/account-email-invitations/${invitation.id}/cancel`;
    const cancelled = await fetch(endpoint, { method: 'POST', headers });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ ok: true });
    const row = (await pool.query('SELECT status,cancelled_at FROM account_email_invitations WHERE id=$1', [invitation.id])).rows[0];
    expect(row.status).toBe('cancelled');
    expect(row.cancelled_at).not.toBeNull();
    const events = await pool.query("SELECT id FROM account_security_events WHERE event_type='account_invitation_cancelled' AND metadata->>'invitationId'=$1", [String(invitation.id)]);
    expect(events.rowCount).toBe(1);
    expect((await fetch(`${base}/api/auth/account-invitation/${inviteToken}`)).status).toBe(404);
    const accepted = await post(`/auth/account-invitation/${inviteToken}/accept`, { username: 'cancelled-invitee', password, passwordConfirm: password, displayName: 'Invitee' });
    expect(accepted.response.status).toBe(404);
    expect((await pool.query("SELECT id FROM users WHERE username='cancelled-invitee'")).rowCount).toBe(0);
    expect((await fetch(endpoint, { method: 'POST', headers })).status).toBe(404);
    expect((await fetch(`${base}/api/admin/account-email-invitations/00000000-0000-0000-0000-000000000000/cancel`, { method: 'POST', headers })).status).toBe(404);
  }, 30_000);

  it('denies members and prevents operators from cancelling privileged invitations', async () => {
    const { generateToken } = await import('../auth/auth');
    const { createAccountEmailInvitation } = await import('./account-email-service');
    const actor = (await pool.query("INSERT INTO users (username,password_hash,role,approval_status) VALUES ($1,$2,'admin','active') RETURNING id", [`invite-owner-${process.pid}`, bcrypt.hashSync(password, 4)])).rows[0];
    const invitation = await createAccountEmailInvitation({ email: 'privileged@example.com', role: 'operator', actorUserId: actor.id });
    for (const role of ['member', 'operator']) {
      const user = (await pool.query("INSERT INTO users (username,password_hash,role,approval_status) VALUES ($1,$2,$3,'active') RETURNING id", [`invite-${role}-${process.pid}`, bcrypt.hashSync(password, 4), role])).rows[0];
      const token = generateToken({ userId: user.id, username: `invite-${role}-${process.pid}`, role });
      const response = await fetch(`${base}/api/admin/account-email-invitations/${invitation.id}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      expect(response.status).toBe(403);
    }
    expect((await pool.query('SELECT status FROM account_email_invitations WHERE id=$1', [invitation.id])).rows[0].status).toBe('pending');
  }, 30_000);
});
