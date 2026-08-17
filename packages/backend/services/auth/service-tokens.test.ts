/**
 * service-tokens.test.ts — Owns: tests for service-tokens.ts.
 *
 * Mocks pg-repo (no real DB) + config (deterministic JWT secret) so we can
 * issue → verify → revoke → list deterministically.
 *
 * 결정: workspace/decisions/2026-05-27-fleet-service-tokens.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

// ── Mocks (must be hoisted before module under test imports) ──
const executeMock = vi.fn();
const queryOneMock = vi.fn();
const queryMock = vi.fn();
vi.mock('../../db/pg-repo.js', () => ({
  query: (...args: any[]) => queryMock(...args),
  queryOne: (...args: any[]) => queryOneMock(...args),
  execute: (...args: any[]) => executeMock(...args),
}));

vi.mock('../../config.js', () => ({
  config: { jwtSecret: 'test-secret-deterministic-32-bytes-min' },
}));

const sut = await import('./service-tokens.js');
const auth = await import('./auth.js');

const NOW_S = Math.floor(Date.now() / 1000);

beforeEach(() => {
  executeMock.mockReset();
  queryOneMock.mockReset();
  queryMock.mockReset();
  sut._resetLastUsedCache();
  // Default execute returns { changes: 1 } so revokeServiceToken's
  // "was anything affected?" check passes in tests that don't override.
  executeMock.mockResolvedValue({ changes: 1 });
});

describe('issueServiceToken', () => {
  it('signs a JWT with aud + issued_for + jti', async () => {
    const result = await sut.issueServiceToken({
      aud: 'fleet',
      userId: 1,
      username: 'admin',
      role: 'admin',
      issuedFor: 'julius@openclaw-vm',
      expiresIn: '1h',
    });

    expect(result.token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(result.jti).toMatch(/^[0-9a-f]{32}$/);

    const decoded = jwt.verify(result.token, 'test-secret-deterministic-32-bytes-min') as any;
    expect(decoded.aud).toBe('fleet');
    expect(decoded.username).toBe('admin');
    expect(decoded.role).toBe('admin');
    expect(decoded.issued_for).toBe('julius@openclaw-vm');
    expect(decoded.jti).toBe(result.jti);
    // expiresAt ≈ now + 1h
    expect(decoded.exp).toBeGreaterThan(NOW_S + 3500);
    expect(decoded.exp).toBeLessThan(NOW_S + 3700);
  });

  it('inserts an audit row in service_tokens', async () => {
    await sut.issueServiceToken({
      aud: 'fleet',
      userId: 7,
      username: 'admin',
      role: 'admin',
      issuedFor: 'julius@host',
      expiresIn: '90d',
    });
    expect(executeMock).toHaveBeenCalledOnce();
    const [sql, vals] = executeMock.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO service_tokens/);
    expect(vals[1]).toBe('fleet');       // aud
    expect(vals[2]).toBe(7);              // user_id
    expect(vals[3]).toBe('julius@host'); // issued_for
  });

  it('defaults to 90d when expiresIn omitted', async () => {
    const result = await sut.issueServiceToken({
      aud: 'fleet',
      userId: 1,
      username: 'admin',
      role: 'admin',
      issuedFor: 'julius@host',
    });
    const decoded = jwt.decode(result.token) as any;
    const days = (decoded.exp - NOW_S) / 86400;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);
  });
});

describe('isJtiRevoked', () => {
  it('returns false for unknown jti (defers to JWT verification)', async () => {
    queryOneMock.mockResolvedValueOnce(null);
    expect(await sut.isJtiRevoked('unknown-jti')).toBe(false);
  });

  it('returns false for known + not revoked', async () => {
    queryOneMock.mockResolvedValueOnce({ revoked_at: null });
    expect(await sut.isJtiRevoked('active-jti')).toBe(false);
  });

  it('returns true for known + revoked', async () => {
    queryOneMock.mockResolvedValueOnce({ revoked_at: '2026-05-27T00:00:00Z' });
    expect(await sut.isJtiRevoked('revoked-jti')).toBe(true);
  });
});

describe('revokeServiceToken', () => {
  it('returns true when a row is updated', async () => {
    executeMock.mockResolvedValueOnce({ changes: 1 });
    expect(await sut.revokeServiceToken('some-jti')).toBe(true);
  });

  it('returns false when jti unknown', async () => {
    executeMock.mockResolvedValueOnce({ changes: 0 });
    expect(await sut.revokeServiceToken('unknown')).toBe(false);
  });
});

describe('touchServiceToken — throttling', () => {
  it('hits DB on first call, skips DB on second call within window', async () => {
    await sut.touchServiceToken('jti-A');
    await sut.touchServiceToken('jti-A');
    expect(executeMock).toHaveBeenCalledOnce(); // throttled
  });

  it('separate jtis do not share throttle', async () => {
    await sut.touchServiceToken('jti-A');
    await sut.touchServiceToken('jti-B');
    expect(executeMock).toHaveBeenCalledTimes(2);
  });
});

describe('listServiceTokens', () => {
  it('no filter → no WHERE clause', async () => {
    queryMock.mockResolvedValueOnce([]);
    await sut.listServiceTokens();
    const [sql] = queryMock.mock.calls[0];
    expect(sql).not.toMatch(/WHERE/);
    expect(sql).toMatch(/ORDER BY issued_at DESC/);
  });

  it('aud filter → single condition', async () => {
    queryMock.mockResolvedValueOnce([]);
    await sut.listServiceTokens({ aud: 'fleet' });
    const [sql, vals] = queryMock.mock.calls[0];
    expect(sql).toMatch(/WHERE aud = \$1/);
    expect(vals).toEqual(['fleet']);
  });

  it('activeOnly → revoked_at IS NULL + expires_at > NOW()', async () => {
    queryMock.mockResolvedValueOnce([]);
    await sut.listServiceTokens({ activeOnly: true });
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toMatch(/revoked_at IS NULL/);
    expect(sql).toMatch(/expires_at > NOW\(\)/);
  });
});

describe('auth.ts scope registry — fleet integration', () => {
  it('fleet is a known scope', () => {
    expect(auth.isKnownScope('fleet')).toBe(true);
  });

  it('fleet is in AUDITED_SCOPES (revocation enforced)', () => {
    expect(auth.AUDITED_SCOPES.has('fleet')).toBe(true);
  });

  it('tower-cli is a known scope but not audited in service_tokens', () => {
    expect(auth.isKnownScope('tower-cli')).toBe(true);
    expect(auth.pathMatchesScopePrefix('/files/read', '/files')).toBe(true);
    expect(auth.AUDITED_SCOPES.has('tower-cli')).toBe(false);
  });

  it('ideas scope was retired with the PM/Ideas API', () => {
    expect(auth.isKnownScope('ideas')).toBe(false);
    expect(auth.AUDITED_SCOPES.has('ideas')).toBe(false);
  });

  it('unknown scope is rejected', () => {
    expect(auth.isKnownScope('definitely-not-real')).toBe(false);
  });
});

describe('pathMatchesScopePrefix — segment-aware matching', () => {
  it('exact match', () => {
    expect(auth.pathMatchesScopePrefix('/sessions', '/sessions')).toBe(true);
  });

  it('subpath match', () => {
    expect(auth.pathMatchesScopePrefix('/sessions/abc', '/sessions')).toBe(true);
    expect(auth.pathMatchesScopePrefix('/sessions/abc/messages', '/sessions')).toBe(true);
  });

  it('REJECTS suffix-extension (the segment-aware fix)', () => {
    expect(auth.pathMatchesScopePrefix('/sessions-extra', '/sessions')).toBe(false);
    expect(auth.pathMatchesScopePrefix('/sessions_secret', '/sessions')).toBe(false);
  });

  it('trailing slash on prefix is normalized', () => {
    expect(auth.pathMatchesScopePrefix('/sessions/abc', '/sessions/')).toBe(true);
    expect(auth.pathMatchesScopePrefix('/sessions', '/sessions/')).toBe(true);
  });
});
