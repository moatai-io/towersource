import { describe, expect, it } from 'vitest';
import { accountSecretMatches, createLoginOtp, createOpaqueAccountToken, hashAccountSecret } from './secrets.js';

describe('account security secrets', () => {
  it('creates opaque one-time tokens', () => {
    const first = createOpaqueAccountToken();
    const second = createOpaqueAccountToken();
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(40);
  });

  it('creates zero-padded six digit OTP values', () => {
    for (let i = 0; i < 25; i += 1) expect(createLoginOtp()).toMatch(/^\d{6}$/);
  });

  it('hashes and compares without storing plaintext', () => {
    const hash = hashAccountSecret('482196', 'test-pepper');
    expect(hash).not.toContain('482196');
    expect(accountSecretMatches('482196', hash, 'test-pepper')).toBe(true);
    expect(accountSecretMatches('111111', hash, 'test-pepper')).toBe(false);
  });
});
