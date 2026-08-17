import { describe, it, expect } from 'vitest';
import { getTokenUserId } from './session-restore';

// Build a fake JWT: header.base64payload.sig
function makeToken(payload: object): string {
  const enc = btoa(JSON.stringify(payload));
  return `fakeheader.${enc}.fakesig`;
}

describe('getTokenUserId', () => {
  it('returns userId from valid token', () => {
    const token = makeToken({ userId: 42, username: 'alice', role: 'admin' });
    expect(getTokenUserId(token)).toBe(42);
  });

  it('returns 0 for null token', () => {
    expect(getTokenUserId(null)).toBe(0);
  });

  it('returns 0 for malformed token', () => {
    expect(getTokenUserId('not-a-jwt')).toBe(0);
  });

  it('returns 0 when userId missing from payload', () => {
    const token = makeToken({ username: 'bob' });
    expect(getTokenUserId(token)).toBe(0);
  });

  it('returns 0 for invalid base64 payload', () => {
    expect(getTokenUserId('h.!!!.s')).toBe(0);
  });
});
