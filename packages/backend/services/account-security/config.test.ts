import { describe, expect, it } from 'vitest';
import { getAccountSecurityConfig, parseLoginEmailOtpPolicy, parseLoginOtpPilotUserIds, requiresBrowserLoginOtp } from './config.js';

describe('account security config', () => {
  it('defaults browser email OTP to off and accepts only off|required', () => {
    expect(parseLoginEmailOtpPolicy(undefined)).toBe('off');
    expect(parseLoginEmailOtpPolicy('off')).toBe('off');
    expect(parseLoginEmailOtpPolicy('required')).toBe('required');
    expect(() => parseLoginEmailOtpPolicy('optional')).toThrow(/off or required/);
  });

  it('selects a pilot only by authenticated numeric user ID', () => {
    const env = { TOWER_LOGIN_EMAIL_OTP: 'off', TOWER_LOGIN_EMAIL_OTP_PILOT_USER_IDS: '7, 19' } as NodeJS.ProcessEnv;
    expect(requiresBrowserLoginOtp(7, env)).toBe(true);
    expect(requiresBrowserLoginOtp(8, env)).toBe(false);
    expect(requiresBrowserLoginOtp(8, { ...env, TOWER_LOGIN_EMAIL_OTP: 'required' })).toBe(true);
    expect(parseLoginOtpPilotUserIds(undefined).size).toBe(0);
    for (const bad of ['woomin1', '0', '1,', '-1', '1.5']) expect(() => parseLoginOtpPilotUserIds(bad)).toThrow();
  });

  it('returns secret-free readiness metadata', () => {
    expect(getAccountSecurityConfig({
      TOWER_LOGIN_EMAIL_OTP: 'off',
      TOWER_ACCOUNT_SECURITY_PEPPER: 'secret',
      TOWER_MAIL_PROVIDER: 'fake',
    })).toMatchObject({
      loginEmailOtpPolicy: 'off', pepperConfigured: true, mailProvider: 'fake',
    });
  });
});

it('requires explicit enrollment mode, cutoff and configured break-glass IDs with no default admin exemption', async () => {
  const { enrollmentEnabledFor }=await import('./config.js');
  expect(enrollmentEnabledFor(1,{})).toBe(false);
  expect(()=>enrollmentEnabledFor(1,{TOWER_LOGIN_EMAIL_ENROLLMENT:'existing'})).toThrow(/cutoff/);
  expect(enrollmentEnabledFor(7,{TOWER_LOGIN_EMAIL_ENROLLMENT:'existing',TOWER_LOGIN_EMAIL_ENROLLMENT_MAX_USER_ID:'7'})).toBe(true);
  expect(enrollmentEnabledFor(8,{TOWER_LOGIN_EMAIL_ENROLLMENT:'existing',TOWER_LOGIN_EMAIL_ENROLLMENT_MAX_USER_ID:'7'})).toBe(false);
  expect(requiresBrowserLoginOtp(1,{TOWER_LOGIN_EMAIL_OTP:'required'})).toBe(true);
  expect(requiresBrowserLoginOtp(1,{TOWER_LOGIN_EMAIL_OTP:'required',TOWER_LOGIN_EMAIL_OTP_EXCLUDED_USER_IDS:'1'})).toBe(false);
});
