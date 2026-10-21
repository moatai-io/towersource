import { afterEach, describe, expect, it } from 'vitest';
import i18n from '../i18n';
import { authErrorMessage } from './auth-error-message';

afterEach(async () => { await i18n.changeLanguage('ko'); });

describe('authErrorMessage', () => {
  it.each([
    ['Invalid credentials', '아이디 또는 이메일과 비밀번호를 확인해 주세요.'],
    ['Account is pending admin approval', '관리자의 가입 승인을 기다리고 있습니다.'],
    ['Account has been disabled', '사용이 중지된 계정입니다. 관리자에게 문의해 주세요.'],
    ['Current password is incorrect', '현재 비밀번호가 올바르지 않습니다.'],
    ['Password must be at least 8 characters', '비밀번호는 8자 이상이어야 합니다.'],
    ['New password must differ from current password', '새 비밀번호는 현재 비밀번호와 달라야 합니다.'],
    ['Invalid invite code', '초대 코드가 유효하지 않거나 사용할 수 없습니다. 관리자에게 확인해 주세요.'],
    ['Invite code is required', '초대 코드를 입력해 주세요.'],
    ['Display name is required', '이름을 입력해 주세요.'],
    ['This reset link is invalid or expired. Request a new one.', '비밀번호 재설정 링크가 유효하지 않거나 만료되었습니다. 새 링크를 요청해 주세요.'],
  ])('localizes known legacy message %s', (input, expected) => {
    expect(authErrorMessage(input, undefined, 'ko-KR')).toBe(expected);
    expect(authErrorMessage(input, undefined, 'en-US')).toMatch(/[A-Za-z]/);
    expect(authErrorMessage(input, undefined, 'en')).not.toMatch(/[가-힣]/);
  });

  it('uses explicit codes without leaking delivery provider diagnostics', () => {
    expect(authErrorMessage('upstream SMTP private diagnostic', 'LOGIN_OTP_DELIVERY', 'ko')).toBe('인증 코드를 보내지 못했습니다. 잠시 후 다시 시도해 주세요.');
    expect(authErrorMessage('Email OTP is not ready: provider issue', 'LOGIN_OTP_NOT_READY', 'en')).toBe('Email verification is not ready. Contact your administrator.');
    expect(authErrorMessage(undefined, 'INVALID_ACCOUNT_EMAIL', 'ko')).toBe('올바른 이메일 주소를 입력해 주세요.');
  });

  it('preserves exact OTP resend/state guidance before broad code fallback', () => {
    expect(authErrorMessage('OTP resend is not available yet', 'LOGIN_OTP_RATE_LIMIT', 'ko')).toBe('아직 인증 코드를 재발송할 수 없습니다. 잠시 후 다시 시도해 주세요.');
    expect(authErrorMessage('OTP challenge expired', 'LOGIN_OTP_STATE', 'en')).toBe('The verification code has expired. Sign in again.');
    expect(authErrorMessage('unrecognized state', 'LOGIN_OTP_STATE', 'ko')).toBe('이 인증 요청을 완료할 수 없습니다. 다시 로그인해 주세요.');
  });

  it('handles canonical username errors without repeating user input', () => {
    expect(authErrorMessage("Username 'demo' is already taken", undefined, 'ko')).toBe('이미 사용 중인 아이디입니다. 다른 아이디를 입력해 주세요.');
    expect(authErrorMessage("Invalid username 'DEMO'. Must match /^[a-z0-9][a-z0-9._-]{1,39}$/ (lowercase, digits, ._-, 2-40 chars).", undefined, 'ko')).toContain('2~40자');
    expect(authErrorMessage("Username 'demo' is already taken private suffix", undefined, 'en')).toBe('The request could not be completed. Try again shortly.');
  });

  it.each([undefined, null, {}, 42, 'Unknown server error', '<script>alert(1)</script>', 'constructor', '__proto__'])('uses a neutral failure for unknown input %j', (input) => {
    expect(authErrorMessage(input, 'constructor', 'ko')).toBe('요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    expect(authErrorMessage(input, 'UNKNOWN', 'en')).toBe('The request could not be completed. Try again shortly.');
  });

  it('follows active i18n language and falls back to Korean for unsupported locales', async () => {
    await i18n.changeLanguage('en');
    expect(authErrorMessage('Invalid OTP')).toBe('The verification code is incorrect.');
    await i18n.changeLanguage('ko');
    expect(authErrorMessage('Invalid OTP')).toBe('인증 코드가 올바르지 않습니다.');
    expect(authErrorMessage('Invalid OTP', undefined, 'fr')).toBe('인증 코드가 올바르지 않습니다.');
  });
});
