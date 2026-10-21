import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Pool } from 'pg';

const name = `tower-reset-it-${process.pid}-${Date.now()}`;
let server: Server;
let base: string;
let pool: Pool;
let closePgPool: () => Promise<void>;
let resetProvider: () => void;
let outbox: Array<{ kind: string; text: string }> = [];
let failNextResetDelivery = false;
let holdResetDelivery: Promise<void> | null = null;
let forceNoticeFailure = false;
let started = false;
let serial = 0;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
const password = 'before-reset-123';
const newPassword = 'after-reset-456';
const waitForMail = async (length: number) => {
  for (let n = 0; n < 100 && outbox.length < length; n++) await new Promise(r => setTimeout(r, 20));
  expect(outbox.length).toBeGreaterThanOrEqual(length);
};
const tokenFromLastMail = () => new URL(outbox.at(-1)!.text.match(/https?:\/\/\S+/)![0]).searchParams.get('passwordReset')!;
const post = async (path: string, body: object, ip = `198.51.100.${++serial % 220 + 1}`) => {
  const res = await fetch(`${base}/api${path}`, { method:'POST', headers:{'content-type':'application/json','x-forwarded-for':ip}, body:JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const create = async (role: string, verified = true, status = 'active', disabled = false) => {
  const username = `reset-${++serial}`;
  const email = `${username}@example.com`;
  const { hashPassword } = await import('../auth/auth.js');
  const user = (await pool.query('INSERT INTO users(username,password_hash,role,approval_status,disabled) VALUES($1,$2,$3,$4,$5) RETURNING id',
    [username,await hashPassword(password),role,status,disabled ? 1 : 0])).rows[0];
  const identity = (await pool.query(`INSERT INTO account_email_identities(user_id,email,email_normalized,state,purpose,verified_at)
    VALUES($1,$2,$2,$3,'existing_user',CASE WHEN $3='verified' THEN NOW() ELSE NULL END) RETURNING id`, [user.id,email,verified ? 'verified' : 'pending'])).rows[0];
  await pool.query('UPDATE users SET primary_email_identity_id=$2 WHERE id=$1',[user.id,identity.id]);
  return { ...user, username, email, identityId: identity.id };
};

beforeAll(async () => {
  docker('run','-d','--rm','--pull=never','--name',name,'-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB=reset_test','-p','127.0.0.1::5432','postgres:16-alpine');
  started = true;
  const port = Number(docker('port',name,'5432/tcp').match(/:(\d+)$/)?.[1]);
  if (!Number.isSafeInteger(port) || port <= 0) throw new Error('Isolated port missing');
  const url = `postgresql://postgres@127.0.0.1:${port}/reset_test`;
  if (new URL(url).pathname === new URL(process.env.DATABASE_URL || 'postgresql://localhost/tower_chat').pathname) throw new Error('Refusing shared database');
  process.env.DATABASE_URL=url;
  process.env.JWT_SECRET='reset-test-only-secret-not-for-production';
  process.env.TOWER_LOGIN_EMAIL_OTP='off';
  process.env.TOWER_MAIL_PROVIDER='';
  const pg=await import('../../db/pg.js'); closePgPool=pg.closePgPool;
  let ready=false;
  for (let n=0;n<40;n++) { try { await pg.getPgPool().query('SELECT 1'); ready=true; break; } catch { await new Promise(r=>setTimeout(r,300)); } }
  if (!ready) throw new Error('Isolated PostgreSQL unavailable');
  await pg.initPg(); pool=pg.getPgPool();
  expect((await pool.query('SELECT current_database() AS db')).rows[0].db).toBe('reset_test');
  const mail=await import('./mail/mail-service.js');resetProvider=mail.resetAccountMailProvider;
  mail.setAccountMailProvider({ name:'capture',checkConnection:async()=>({configured:true,connection:'ok'}),send:async message=>{
    if (message.kind==='password_changed_notice' && forceNoticeFailure) throw new Error('synthetic notice failure');
    if (message.kind==='password_reset' && holdResetDelivery) await holdResetDelivery;
    if (message.kind==='password_reset' && failNextResetDelivery) { failNextResetDelivery=false;throw new Error('synthetic delivery failure'); }
    outbox.push({kind:message.kind,text:message.text});return {providerMessageId:'fixture'};
  } });
  const router=(await import('../../routes/api.js')).default;
  const app=express();app.set('trust proxy',1);app.use(express.json());app.use('/api',router);
  server=createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
},120_000);
beforeEach(()=>{outbox=[];failNextResetDelivery=false;holdResetDelivery=null;forceNoticeFailure=false;process.env.TOWER_LOGIN_EMAIL_OTP='off';process.env.TOWER_LOGIN_EMAIL_OTP_PILOT_USER_IDS='';});
afterAll(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));if(resetProvider)resetProvider();if(closePgPool)await closePgPool();if(started)docker('rm','-f','-v',name);},30_000);

describe('isolated password reset and verified-email login',()=>{
  it('uses verified primary email alias, preserves username and fails closed on collision',async()=>{
    const user=await create('member');
    expect((await post('/auth/login',{username:user.username,password})).status).toBe(200);
    expect((await post('/auth/login',{username:user.email.toUpperCase(),password})).status).toBe(200);
    const pending=await create('member',false);
    expect((await post('/auth/login',{username:pending.email,password})).status).toBe(401);
    expect((await post('/auth/login',{username:pending.username,password})).status).toBe(200);
    // Valid legacy username may contain '@' in an imported database; never choose either account.
    const collision=await create('member');
    await pool.query('UPDATE users SET username=$1 WHERE id=$2',[user.email,collision.id]);
    expect((await post('/auth/login',{username:user.email,password})).status).toBe(401);
    expect((await post('/auth/login',{username:user.username,password})).status).toBe(200);
  });
  it('gives indistinguishable public request responses and only mails eligible verified active accounts of every role',async()=>{
    const eligible=await create('viewer');
    const forbidden=await Promise.all([create('guest',false),create('member',true,'pending'),create('member',true,'rejected'),create('member',true,'active',true)]);
    for(const email of ['unknown@example.com', ...forbidden.map(u=>u.email)]) {
      expect(await post('/auth/password-reset/request',{email})).toEqual({status:200,body:{ok:true}});
    }
    await new Promise(r=>setTimeout(r,100)); expect(outbox).toHaveLength(0);
    expect(await post('/auth/password-reset/request',{email:eligible.email.toUpperCase()})).toEqual({status:200,body:{ok:true}});
    await waitForMail(1);expect(outbox[0].kind).toBe('password_reset');
  });
  it('protects the admin reset-email endpoint and only accepts stored verified identities',async()=>{
    const admin=await create('admin');const member=await create('member');const pending=await create('guest',false);
    const login=await post('/auth/login',{username:admin.username,password});
    const memberLogin=await post('/auth/login',{username:member.username,password});
    const send=async(id:number,token?:string)=>{
      const response=await fetch(`${base}/api/admin/users/${id}/password-reset-email`,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({email:'ignored@example.com'})});
      return {status:response.status,body:await response.json()};
    };
    expect((await send(member.id)).status).toBe(401);
    expect((await send(member.id,memberLogin.body.token)).status).toBe(403);
    expect((await send(pending.id,login.body.token)).status).toBe(409);
    expect(await send(member.id,login.body.token)).toEqual({status:200,body:{ok:true}});
    expect(outbox).toHaveLength(1);
    expect((await send(member.id,login.body.token)).status).toBe(409);
    failNextResetDelivery=true;
    expect((await send(admin.id,login.body.token)).status).toBe(503);
  });
  it('admin delivery awaits provider acceptance, records actor, limits repeats and reports failure',async()=>{
    const {requestPasswordReset}=await import('./password-reset-service.js');
    const admin=await create('admin');const target=await create('member');
    const input={email:target.email,targetUserId:target.id,actorUserId:admin.id,ip:'203.0.113.31'};
    expect(await requestPasswordReset({...input,targetUserId:admin.id})).toBe('unavailable');
    expect(outbox).toHaveLength(0);
    expect(await requestPasswordReset(input)).toBe('accepted');
    expect(outbox).toHaveLength(1);
    expect((await pool.query("SELECT actor_user_id,target_user_id FROM account_security_events WHERE event_type='admin_password_reset_requested' AND target_user_id=$1",[target.id])).rows).toEqual([{actor_user_id:admin.id,target_user_id:target.id}]);
    expect(await requestPasswordReset(input)).toBe('unavailable');
    const other=await create('admin');failNextResetDelivery=true;
    expect(await requestPasswordReset({...input,email:other.email,targetUserId:other.id})).toBe('delivery_failed');
    expect((await pool.query('SELECT status FROM account_password_reset_challenges WHERE user_id=$1',[other.id])).rows[0].status).toBe('delivery_failed');
  });
  it.each(['admin','operator','member','guest','viewer'])('allows %s recovery without changing role and invalidates old credentials',async role=>{
    const user=await create(role);
    await post('/auth/password-reset/request',{email:user.email});await waitForMail(1);
    const token=tokenFromLastMail();
    expect((await post('/auth/password-reset/confirm',{token,password:newPassword})).status).toBe(200);
    expect((await pool.query('SELECT role,auth_epoch FROM users WHERE id=$1',[user.id])).rows[0]).toMatchObject({role,auth_epoch:1});
    expect((await post('/auth/login',{username:user.email,password})).status).toBe(401);
    expect((await post('/auth/login',{username:user.email,password:newPassword})).status).toBe(200);
    expect((await post('/auth/password-reset/confirm',{token,password:newPassword})).status).toBe(400);
    await waitForMail(2);
  });
  it('consumes once under race, hashes password, invalidates old JWT and pending capabilities',async()=>{
    const user=await create('member');
    const old=await post('/auth/cli-login',{username:user.username,password}); expect(old.status).toBe(200);
    const browser=await post('/auth/login',{username:user.username,password});expect(browser.status).toBe(200);
    await post('/auth/password-reset/request',{email:user.email});await waitForMail(1);
    const token=tokenFromLastMail();
    const results=await Promise.all([post('/auth/password-reset/confirm',{token,password:newPassword}),post('/auth/password-reset/confirm',{token,password:newPassword})]);
    expect(results.map(r=>r.status).sort()).toEqual([200,400]);
    await waitForMail(2);expect(outbox.some(mail=>mail.kind==='password_changed_notice')).toBe(true);
    const { verifyStoredPassword }=await import('../auth/auth.js');
    const row=(await pool.query('SELECT password_hash,auth_epoch FROM users WHERE id=$1',[user.id])).rows[0];
    expect(row.password_hash).toMatch(/^\$argon2id\$/);expect(row.auth_epoch).toBe(1);
    expect(await verifyStoredPassword(newPassword,row.password_hash)).toBe(true);
    expect((await post('/auth/login',{username:user.email,password})).status).toBe(401);
    expect((await post('/auth/login',{username:user.email,password:newPassword})).status).toBe(200);
    const check=await fetch(`${base}/api/auth/check`,{headers:{authorization:`Bearer ${old.body.token}`}});expect(check.status).toBe(401);
    const browserCheck=await fetch(`${base}/api/auth/check`,{headers:{authorization:`Bearer ${browser.body.token}`}});expect(browserCheck.status).toBe(401);
    expect((await post('/auth/password-reset/confirm',{token,password:newPassword})).status).toBe(400);
  });
  it('limits account and IP requests without invalidating a usable link',async()=>{
    const user=await create('member');
    await post('/auth/password-reset/request',{email:user.email},'203.0.113.55');await waitForMail(1);
    const token=tokenFromLastMail();
    await post('/auth/password-reset/request',{email:user.email},'203.0.113.56');
    await new Promise(r=>setTimeout(r,50));expect(outbox).toHaveLength(1);
    await pool.query("UPDATE account_password_reset_challenges SET created_at=NOW()-INTERVAL '61 seconds' WHERE user_id=$1",[user.id]);
    await post('/auth/password-reset/request',{email:user.email},'203.0.113.56');
    await waitForMail(2);
    const newer=tokenFromLastMail();expect(newer).not.toBe(token);
    expect((await post('/auth/password-reset/confirm',{token,password:newPassword})).status).toBe(200);
    expect((await post('/auth/password-reset/confirm',{token:newer,password:newPassword})).status).toBe(400);
    const repeated=await create('member');
    await post('/auth/password-reset/request',{email:repeated.email},'203.0.113.88');await waitForMail(4);
    for(let n=0;n<2;n++) {
      await pool.query("UPDATE account_password_reset_challenges SET created_at=NOW()-INTERVAL '61 seconds' WHERE user_id=$1",[repeated.id]);
      await post('/auth/password-reset/request',{email:repeated.email},`203.0.113.${89+n}`);
      await waitForMail(5+n);
    }
    await pool.query("UPDATE account_password_reset_challenges SET created_at=NOW()-INTERVAL '61 seconds' WHERE user_id=$1",[repeated.id]);
    await post('/auth/password-reset/request',{email:repeated.email},'203.0.113.91');
    await new Promise(r=>setTimeout(r,60));
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM account_password_reset_challenges WHERE user_id=$1',[repeated.id])).rows[0].n).toBe(3);
    const blocked=await create('guest');
    for(let n=0;n<10;n++) expect(await post('/auth/password-reset/request',{email:'unknown@example.com'},'203.0.113.77')).toEqual({status:200,body:{ok:true}});
    await post('/auth/password-reset/request',{email:blocked.email},'203.0.113.77');
    await new Promise(r=>setTimeout(r,60));
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM account_password_reset_challenges WHERE user_id=$1',[blocked.id])).rows[0].n).toBe(0);
  });
  it('retries after a failed delivery and suppresses duplicate requests while send is in flight',async()=>{
    const user=await create('member');
    failNextResetDelivery=true;
    await post('/auth/password-reset/request',{email:user.email});
    for(let n=0;n<100;n++) {
      const state=(await pool.query('SELECT status FROM account_password_reset_challenges WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',[user.id])).rows[0]?.status;
      if(state==='delivery_failed') break;
      await new Promise(r=>setTimeout(r,20));
    }
    expect(outbox).toHaveLength(0);
    expect((await pool.query('SELECT status FROM account_password_reset_challenges WHERE user_id=$1',[user.id])).rows[0].status).toBe('delivery_failed');
    await pool.query("UPDATE account_password_reset_challenges SET created_at=NOW()-INTERVAL '61 seconds' WHERE user_id=$1",[user.id]);
    let release!:()=>void;
    holdResetDelivery=new Promise<void>(resolve=>{release=resolve;});
    await post('/auth/password-reset/request',{email:user.email});
    await post('/auth/password-reset/request',{email:user.email});
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM account_password_reset_challenges WHERE user_id=$1',[user.id])).rows[0].n).toBe(2);
    release();holdResetDelivery=null;
    await waitForMail(1);
    expect((await post('/auth/password-reset/confirm',{token:tokenFromLastMail(),password:newPassword})).status).toBe(200);
  });
  it('keeps the reset committed if the changed-password notice fails',async()=>{
    const user=await create('member');
    await post('/auth/password-reset/request',{email:user.email});await waitForMail(1);
    forceNoticeFailure=true;
    expect((await post('/auth/password-reset/confirm',{token:tokenFromLastMail(),password:newPassword})).status).toBe(200);
    for(let n=0;n<100;n++) {
      const count=(await pool.query("SELECT COUNT(*)::int AS n FROM account_security_events WHERE target_user_id=$1 AND event_type='password_changed_notice_delivery_failed'",[user.id])).rows[0].n;
      if(count) break;
      await new Promise(r=>setTimeout(r,20));
    }
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM account_security_events WHERE target_user_id=$1 AND event_type='password_changed_notice_delivery_failed'",[user.id])).rows[0].n).toBe(1);
    expect((await post('/auth/login',{username:user.username,password:newPassword})).status).toBe(200);
  });
  it('serializes an in-flight identity change and rejects the old reset link',async()=>{
    const user=await create('member');
    await post('/auth/password-reset/request',{email:user.email});await waitForMail(1);
    const token=tokenFromLastMail();
    const blocker=await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('UPDATE users SET primary_email_identity_id=NULL WHERE id=$1',[user.id]);
      const pending=post('/auth/password-reset/confirm',{token,password:newPassword});
      await new Promise(r=>setTimeout(r,80));
      await blocker.query('COMMIT');
      expect((await pending).status).toBe(400);
      expect((await post('/auth/login',{username:user.username,password})).status).toBe(200);
    } finally { await blocker.query('ROLLBACK');blocker.release(); }
  });
  it('rejects random links without changing any password or challenge',async()=>{
    const user=await create('member');
    const before=(await pool.query('SELECT password_hash FROM users WHERE id=$1',[user.id])).rows[0].password_hash;
    for(let n=0;n<2;n++) expect((await post('/auth/password-reset/confirm',{token:'A'.repeat(43),password:newPassword})).status).toBe(400);
    expect((await pool.query('SELECT password_hash FROM users WHERE id=$1',[user.id])).rows[0].password_hash).toBe(before);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM account_password_reset_challenges WHERE user_id=$1',[user.id])).rows[0].n).toBe(0);
  });
  it('reset cancels OTP and rejects an old authenticated payload from creating another OTP',async()=>{
    const user=await create('member');
    const {authenticateUser}=await import('../auth/auth.js');
    const auth=await authenticateUser(user.username,password,{deferSuccess:true});
    const otp=await import('./login-otp-service.js');
    process.env.TOWER_LOGIN_EMAIL_OTP_PILOT_USER_IDS=String(user.id);
    const challenge=await otp.createLoginOtpChallenge({payload:auth.payload!});
    const otpCode=outbox.at(-1)!.text.match(/\b\d{6}\b/)![0];
    await post('/auth/password-reset/request',{email:user.email});await waitForMail(2);
    const token=tokenFromLastMail();
    expect((await post('/auth/password-reset/confirm',{token,password:newPassword})).status).toBe(200);
    await expect(otp.verifyLoginOtpChallenge({challengeId:challenge.challengeId,otp:otpCode})).rejects.toThrow();
    await expect(otp.createLoginOtpChallenge({payload:auth.payload!})).rejects.toThrow('Credential changed');
    // Browser login still requires OTP after recovery; no password-only downgrade.
    expect((await post('/auth/login',{username:user.email,password:newPassword})).status).toBe(202);
  });
  it('rejects expiry, disabled/changed primary email and epoch changes at consumption',async()=>{
    for(const change of ['expired','disabled','email','epoch']) {
      const user=await create('member');await post('/auth/password-reset/request',{email:user.email});await waitForMail(1);
      const token=tokenFromLastMail();
      if(change==='expired') await pool.query("UPDATE account_password_reset_challenges SET expires_at=NOW()-INTERVAL '1 second' WHERE user_id=$1",[user.id]);
      if(change==='disabled') await pool.query('UPDATE users SET disabled=1 WHERE id=$1',[user.id]);
      if(change==='email') await pool.query('UPDATE users SET primary_email_identity_id=NULL WHERE id=$1',[user.id]);
      if(change==='epoch') await pool.query('UPDATE users SET auth_epoch=auth_epoch+1 WHERE id=$1',[user.id]);
      expect((await post('/auth/password-reset/confirm',{token,password:newPassword})).status).toBe(400);
      outbox=[];
    }
  });
});
