import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', () => ({ config: { jwtSecret: 'test-public-visitor-secret' } }));

const { resolvePublicVisitorIdentity } = await import('./public-visitor-identity.js');

function response() {
  const headers = new Map<string, string | string[]>();
  return {
    headers,
    setHeader(name: string, value: string | string[]) { headers.set(name, value); },
    getHeader(name: string) { return headers.get(name); },
  };
}

function cookieFrom(res: ReturnType<typeof response>): string {
  const header = res.headers.get('Set-Cookie');
  const value = Array.isArray(header) ? header[0] : header;
  return String(value || '').split(';')[0];
}

describe('AI Service public visitor identity', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('mints an HttpOnly signed visitor cookie and opaque Channel-scoped keys', () => {
    vi.spyOn(crypto, 'randomBytes').mockReturnValue(Buffer.alloc(24, 7));
    const res = response();
    const identity = resolvePublicVisitorIdentity({ headers: {} }, res, 'channel-1');
    const setCookie = String(res.headers.get('Set-Cookie'));
    expect(setCookie).toContain('__Host-tower_ai_visitor=taiv_v1.');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(identity.tenantKey).toMatch(/^public:[A-Za-z0-9_-]{43}$/);
    expect(identity.userKey).toMatch(/^visitor:[A-Za-z0-9_-]{43}$/);
    expect(identity.userKey).not.toContain('7.7.7.7');
  });

  it('restores the same visitor from its signed cookie without issuing another cookie', () => {
    const first = response();
    const identity = resolvePublicVisitorIdentity({ headers: {} }, first, 'channel-1');
    const second = response();
    const restored = resolvePublicVisitorIdentity({ headers: { cookie: cookieFrom(first) } }, second, 'channel-1');
    expect(restored).toEqual(identity);
    expect(second.headers.has('Set-Cookie')).toBe(false);
  });

  it('does not correlate the same browser user key across Channels', () => {
    const first = response();
    resolvePublicVisitorIdentity({ headers: {} }, first, 'channel-1');
    const cookie = cookieFrom(first);
    const channelOne = resolvePublicVisitorIdentity({ headers: { cookie } }, response(), 'channel-1');
    const channelTwo = resolvePublicVisitorIdentity({ headers: { cookie } }, response(), 'channel-2');
    expect(channelTwo.userKey).not.toBe(channelOne.userKey);
    expect(channelTwo.tenantKey).not.toBe(channelOne.tenantKey);
  });

  it('rotates a tampered cookie instead of trusting its visitor id', () => {
    const res = response();
    const identity = resolvePublicVisitorIdentity({ headers: { cookie: '__Host-tower_ai_visitor=taiv_v1.fake.fake' } }, res, 'channel-1');
    expect(identity.userKey).toMatch(/^visitor:/);
    expect(String(res.headers.get('Set-Cookie'))).toContain('__Host-tower_ai_visitor=taiv_v1.');
  });
});
