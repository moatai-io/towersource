import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const service=readFileSync(new URL('./login-otp-service.ts',import.meta.url),'utf8');
const routes=readFileSync(new URL('../../routes/api.ts',import.meta.url),'utf8');
const auth=readFileSync(new URL('../auth/auth.ts',import.meta.url),'utf8');

describe('browser login OTP phase-two source contracts',()=>{
  it('keeps password-only browser login when the policy is off',()=>{
    expect(routes).toContain('requiresBrowserLoginOtp(result.payload.userId)');
    expect(routes).toMatch(/if \(requiresBrowserLoginOtp\(result\.payload\.userId\)\)[\s\S]*?const token = generateToken\(result\.payload\);/);
  });

  it('returns only an OTP challenge before issuing a browser session or success event',()=>{
    const loginStart=routes.indexOf("router.post('/auth/login'");
    const verifyStart=routes.indexOf("router.post('/auth/login/otp/verify'");
    const loginRoute=routes.slice(loginStart,verifyStart);
    const requiredBranch=loginRoute.slice(loginRoute.indexOf('if (requiresBrowserLoginOtp'),loginRoute.indexOf('await completeAuthenticationSuccess'));
    expect(requiredBranch).toContain('createLoginOtpChallenge');
    expect(requiredBranch).not.toContain('generateToken');
    expect(requiredBranch).not.toContain('setTokenCookie');
    expect(loginRoute).toContain('deferSuccess:true');
    expect(auth).toContain('if (!context?.deferSuccess)');
    expect(auth).toMatch(/if \(!context\?\.deferSuccess\)[\s\S]*?completeAuthenticationSuccess/);
    expect(requiredBranch).not.toContain('completeAuthenticationSuccess');
    expect(service).not.toMatch(/return \{[^}]*otp[^A-Za-z]*(?:,|})/);
  });

  it('issues the session only after the OTP challenge is consumed',()=>{
    expect(service).toContain("status='consumed',consumed_at=NOW()");
    expect(routes).toMatch(/verifyLoginOtpChallenge[\s\S]*?completeAuthenticationSuccess[\s\S]*?generateToken\(payload\)[\s\S]*?setTokenCookie\(res,token\)/);
  });

  it('enforces expiry, five attempts, one-time state, resend delay and send window',()=>{
    expect(service).toContain('const OTP_TTL_MS = 10 * 60 * 1000');
    expect(service).toContain('const RESEND_DELAY_MS = 60 * 1000');
    expect(service).toContain('const MAX_SENDS_PER_WINDOW = 5');
    expect(service).toContain('const MAX_FAILED_ATTEMPTS = 5');
    expect(service).toContain("row.status!=='pending'");
    expect(service).toContain("THEN 'attempts_exceeded'");
    expect(service).toContain("status='superseded',superseded_at=NOW()");
  });

  it('blocks required login when coverage or mail readiness fails',()=>{
    expect(service).toContain('await assertRequiredReadiness(input.payload.userId)');
    expect(service).toContain("u.disabled=0 AND u.approval_status='active'");
    expect(routes).toContain("code: error.code");
    expect(routes).toContain("res.status(503).json({ error: 'Email OTP login is not ready'");
  });

  it('does not apply browser OTP policy to CLI login',()=>{
    const cliStart=routes.indexOf("router.post('/auth/cli-login'");
    const cliEnd=routes.indexOf("router.post('/auth/logout'",cliStart);
    const cliRoute=routes.slice(cliStart,cliEnd);
    expect(cliRoute).toContain("generateScopedToken(result.payload, { aud: 'tower-cli'");
    expect(cliRoute).not.toContain('createLoginOtpChallenge');
    expect(cliRoute).not.toContain('loginEmailOtpPolicy');
  });
});
