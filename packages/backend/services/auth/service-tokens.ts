/**
 * service-tokens.ts — Owns: long-lived scoped JWT issuance + audit.
 * Public API: issueServiceToken, listServiceTokens, revokeServiceToken,
 *             touchServiceToken, isJtiRevoked, getServiceTokenByJti.
 *
 * 본 모듈은 fleet 등 *발급/회전/회수* 가 필요한 토큰 전용. pm-capture 의
 * 15분짜리 'ideas' scope 같은 일회성은 직접 generateScopedToken 호출.
 *
 * 결정: workspace/decisions/2026-05-27-fleet-service-tokens.md
 * Issue: internal issue #36
 * See also: auth.ts (generateScopedToken, SCOPE_PREFIXES).
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../../config.js';
import { query, queryOne, execute } from '../../db/pg-repo.js';
import type { JwtPayload } from './auth.js';

// ───── Types ─────

export interface ServiceTokenRow {
  jti: string;
  aud: string;
  user_id: number;
  issued_for: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface IssueServiceTokenOpts {
  /** scope claim — must be a key in auth.ts SCOPE_PREFIXES */
  aud: string;
  /** user id whose role/identity the token represents (typically admin on the target VM) */
  userId: number;
  /** display username for the JWT payload (audit-visible) */
  username: string;
  /** role to embed in JWT (typically 'admin') */
  role: string;
  /** operator-side audit identifier — e.g. 'julius@openclaw-vm' */
  issuedFor: string;
  /** zeit/ms style ('90d', '24h', '15m') — passed to jwt.sign */
  expiresIn?: string;
}

export interface IssuedServiceToken {
  token: string;
  jti: string;
  expiresAt: Date;
}

// ───── Issuance ─────

/**
 * Issue a long-lived scoped JWT and audit it in service_tokens.
 *
 * Caller must validate `aud` is a known scope (auth.ts SCOPE_PREFIXES key)
 * — this module does not import that map to avoid a cycle. Use the
 * `assertKnownScope` helper exported from auth.ts in the route handler.
 */
export async function issueServiceToken(
  opts: IssueServiceTokenOpts,
): Promise<IssuedServiceToken> {
  const jti = crypto.randomBytes(16).toString('hex'); // 32-char hex
  const expiresIn = opts.expiresIn ?? '90d';

  const payload: JwtPayload & { issued_for: string } = {
    userId: opts.userId,
    username: opts.username,
    role: opts.role,
    aud: opts.aud,
    issued_for: opts.issuedFor,
  };

  const token = jwt.sign(payload, config.jwtSecret, {
    expiresIn: expiresIn as any,
    jwtid: jti,
  });

  // Decode to grab exact exp (epoch seconds) so the row matches the token.
  const decoded = jwt.decode(token) as { exp: number } | null;
  if (!decoded || !decoded.exp) {
    throw new Error('Failed to decode just-signed token (jwt library bug?)');
  }
  const expiresAt = new Date(decoded.exp * 1000);

  await execute(
    `INSERT INTO service_tokens (jti, aud, user_id, issued_for, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [jti, opts.aud, opts.userId, opts.issuedFor, expiresAt.toISOString()],
  );

  return { token, jti, expiresAt };
}

// ───── Lookups ─────

export async function getServiceTokenByJti(jti: string): Promise<ServiceTokenRow | null> {
  return (await queryOne<ServiceTokenRow>(
    'SELECT * FROM service_tokens WHERE jti = $1',
    [jti],
  )) ?? null;
}

export async function listServiceTokens(opts?: {
  aud?: string;
  activeOnly?: boolean;
}): Promise<ServiceTokenRow[]> {
  const conds: string[] = [];
  const vals: any[] = [];
  let i = 1;
  if (opts?.aud) {
    conds.push(`aud = $${i++}`);
    vals.push(opts.aud);
  }
  if (opts?.activeOnly) {
    conds.push(`revoked_at IS NULL`);
    conds.push(`expires_at > NOW()`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return query<ServiceTokenRow>(
    `SELECT * FROM service_tokens ${where} ORDER BY issued_at DESC`,
    vals,
  );
}

// ───── Revocation ─────

/**
 * Mark a token as revoked. Idempotent — already-revoked rows are touched
 * to NOW() so the audit trail reflects the latest revocation attempt.
 * Returns true if a row was updated, false if jti unknown.
 */
export async function revokeServiceToken(jti: string): Promise<boolean> {
  const result = await execute(
    `UPDATE service_tokens SET revoked_at = NOW() WHERE jti = $1`,
    [jti],
  );
  return (result?.changes ?? 0) > 0;
}

/**
 * Quick auth-middleware check: is this jti revoked OR expired according
 * to the DB? Returns null if unknown jti (treated as "not in audit table"
 * — e.g. short-lived pm-capture token, which is fine).
 *
 * NOTE: Expiration is enforced by JWT verification itself; this check
 * exists so that revocation works *even if the token hasn't expired*.
 * Unknown jti is *allowed* — only known-and-revoked is denied.
 */
export async function isJtiRevoked(jti: string): Promise<boolean> {
  const row = await queryOne<{ revoked_at: string | null }>(
    'SELECT revoked_at FROM service_tokens WHERE jti = $1',
    [jti],
  );
  if (!row) return false; // unknown jti → not a fleet token, defer to JWT verification
  return row.revoked_at !== null;
}

// ───── Usage tracking ─────

/**
 * Update last_used_at on a service token. Throttled to 60s per jti
 * to avoid hammering the DB on every API request.
 */
const lastUsedCache = new Map<string, number>();
const LAST_USED_THROTTLE_MS = 60 * 1000;

export async function touchServiceToken(jti: string): Promise<void> {
  const now = Date.now();
  const cachedAt = lastUsedCache.get(jti);
  if (cachedAt && now - cachedAt < LAST_USED_THROTTLE_MS) {
    return;
  }
  lastUsedCache.set(jti, now);
  await execute(
    `UPDATE service_tokens SET last_used_at = NOW() WHERE jti = $1`,
    [jti],
  );
}

/** Test helper — clear the throttle cache between tests. */
export function _resetLastUsedCache() {
  lastUsedCache.clear();
}
