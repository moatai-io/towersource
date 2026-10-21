import crypto from 'crypto';

const TOKEN_BYTES = 32;

export function createOpaqueAccountToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

export function createLoginOtp(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function hashAccountSecret(secret: string, pepper: string): string {
  if (!pepper) throw new Error('Account security pepper is required');
  return crypto.createHmac('sha256', pepper).update(secret, 'utf8').digest('hex');
}

export function accountSecretMatches(secret: string, expectedHash: string, pepper: string): boolean {
  const actual = Buffer.from(hashAccountSecret(secret, pepper), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
