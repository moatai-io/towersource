import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks=vi.hoisted(()=>({queryOne:vi.fn(),transaction:vi.fn(),send:vi.fn(),checkConnection:vi.fn()}));
vi.mock('../../config.js',()=>({config:{jwtSecret:'test-jwt-secret'}}));
vi.mock('../../db/pg-repo.js',()=>({queryOne:mocks.queryOne,transaction:mocks.transaction}));
vi.mock('./mail/mail-service.js',()=>({getAccountMailProvider:()=>({name:'fake',send:mocks.send,checkConnection:mocks.checkConnection})}));

import {
  LoginOtpInvalidError,
  LoginOtpNotFoundError,
  LoginOtpStateError,
  cancelLoginOtpChallenge,
  verifyLoginOtpChallenge,
} from './login-otp-service.js';
import { hashAccountSecret } from './secrets.js';

const pepper='test-account-pepper';
const validOtp='123456';

interface StoredChallenge {
  id:string; user_id:number; email_identity_id:number; email:string; otp_hash:string; status:string;
  failed_attempts:number; expires_at:string; resend_available_at:string; username:string; role:string;
  disabled:number; approval_status:string; auth_epoch:number; consumed_at?:string; superseded_at?:string;
}

function fixture(overrides:Partial<StoredChallenge>={}) {
  const challenge:StoredChallenge={
    id:'challenge-1',user_id:7,email_identity_id:11,email:'u@example.com',otp_hash:hashAccountSecret(validOtp,pepper),
    status:'pending',failed_attempts:0,expires_at:new Date(Date.now()+60_000).toISOString(),
    resend_available_at:new Date(Date.now()-1_000).toISOString(),username:'user-7',role:'member',disabled:0,approval_status:'active',auth_epoch:0,
    ...overrides,
  };
  const client={query:vi.fn(async(sql:string,params?:unknown[])=>{
    if(sql.includes('SELECT user_id FROM auth_login_otp_challenges')) return {rows:challenge.id===params?.[0]?[{user_id:challenge.user_id}]:[]};
    if(sql.includes('SELECT id FROM users')) return {rows:[{id:challenge.user_id}]};
    if(sql.includes('FROM auth_login_otp_challenges c JOIN users')) return {rows:challenge.id===params?.[0]?[{...challenge,current_auth_epoch:challenge.auth_epoch}]:[]};
    if(sql.includes("SET status='cancelled'")) { challenge.status='cancelled'; return {rows:[]}; }
    if(sql.includes("SET status='expired'")) { challenge.status='expired'; return {rows:[]}; }
    if(sql.includes('SET failed_attempts=')) {
      challenge.failed_attempts=Number(params?.[1]);
      if(challenge.failed_attempts>=5) challenge.status='attempts_exceeded';
      return {rows:[]};
    }
    if(sql.includes("SET status='consumed'")) { challenge.status='consumed'; challenge.consumed_at=new Date().toISOString(); return {rows:[]}; }
    throw new Error(`Unhandled SQL: ${sql}`);
  })};
  mocks.transaction.mockImplementation(async(fn:(client:typeof client)=>unknown)=>fn(client));
  mocks.queryOne.mockImplementation(async(sql:string,params?:unknown[])=>{
    if(sql.includes('INSERT INTO account_security_events')) return {id:1};
    if(sql.includes("UPDATE auth_login_otp_challenges SET status='cancelled'")) {
      if(challenge.id===params?.[0]&&challenge.status==='pending') { challenge.status='cancelled'; return {user_id:challenge.user_id}; }
      return undefined;
    }
    throw new Error(`Unhandled queryOne SQL: ${sql}`);
  });
  return {challenge,client};
}

beforeEach(()=>{
  vi.clearAllMocks();
  vi.stubEnv('TOWER_ACCOUNT_SECURITY_PEPPER',pepper);
  vi.stubEnv('TOWER_LOGIN_EMAIL_OTP','off');
  vi.stubEnv('TOWER_LOGIN_EMAIL_OTP_PILOT_USER_IDS','7');
});

afterEach(()=>vi.unstubAllEnvs());

describe('login OTP persisted state transitions',()=>{
  it('consumes a correct OTP exactly once',async()=>{
    const {challenge}=fixture();
    await expect(verifyLoginOtpChallenge({challengeId:challenge.id,otp:validOtp})).resolves.toEqual({userId:7,username:'user-7',role:'member',authEpoch:0});
    expect(challenge.status).toBe('consumed');
    await expect(verifyLoginOtpChallenge({challengeId:challenge.id,otp:validOtp})).rejects.toBeInstanceOf(LoginOtpNotFoundError);
  });

  it('persists failed attempts and closes the challenge on the fifth failure',async()=>{
    const {challenge}=fixture();
    for(let attempt=1;attempt<=5;attempt+=1) {
      await expect(verifyLoginOtpChallenge({challengeId:challenge.id,otp:'000000'})).rejects.toBeInstanceOf(LoginOtpInvalidError);
      expect(challenge.failed_attempts).toBe(attempt);
    }
    expect(challenge.status).toBe('attempts_exceeded');
    await expect(verifyLoginOtpChallenge({challengeId:challenge.id,otp:validOtp})).rejects.toBeInstanceOf(LoginOtpNotFoundError);
  });

  it('persists expiry and refuses a later correct OTP',async()=>{
    const {challenge}=fixture({expires_at:new Date(Date.now()-1_000).toISOString()});
    await expect(verifyLoginOtpChallenge({challengeId:challenge.id,otp:validOtp})).rejects.toBeInstanceOf(LoginOtpStateError);
    expect(challenge.status).toBe('expired');
    await expect(verifyLoginOtpChallenge({challengeId:challenge.id,otp:validOtp})).rejects.toBeInstanceOf(LoginOtpNotFoundError);
  });

  it('cancels only a pending challenge and remains idempotently closed',async()=>{
    const {challenge}=fixture();
    await expect(cancelLoginOtpChallenge({challengeId:challenge.id})).resolves.toBe(true);
    expect(challenge.status).toBe('cancelled');
    await expect(cancelLoginOtpChallenge({challengeId:challenge.id})).resolves.toBe(false);
  });
});
