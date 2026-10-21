import crypto from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import bcrypt from 'bcryptjs';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { config } from '../../config.js';
import { query, queryOne, execute, transaction } from '../../db/pg-repo.js';
import { VALID_ROLES } from '../damage-control.js';
import type { Request, Response, NextFunction } from 'express';

export interface JwtPayload {
  userId: number;
  username: string;
  role: string;
  /**
   * Audience claim. When present, the token can ONLY access routes
   * matching that scope (enforced by authMiddleware). Used for service
   * tokens so automation cannot call unrelated API namespaces.
   *
   * Current scopes:
   *   'fleet' — managed-VM operations subset
   *
   * Tokens WITHOUT aud have full user access (browser sessions).
   */
  aud?: string;
  projectId?: string;
  credentialId?: string;
  connectionScope?: 'agent' | 'organization';
  connectionMode?: 'create' | 'reauth';
  /** Incremented on reactivation; missing claims are accepted only for untouched legacy accounts. */
  authEpoch?: number;
}

// ───── AES-256-GCM legacy read compatibility (never use for new writes) ─────

const ALGO = 'aes-256-gcm';

function deriveKey(): Buffer {
  // Derive a 32-byte key from JWT secret using SHA-256
  return crypto.createHash('sha256').update(config.jwtSecret).digest();
}

/** @deprecated Test/legacy compatibility only. Never use for new password writes. */
export function encryptPassword(plain: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:encrypted (all hex)
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptPassword(stored: string): string | null {
  try {
    const [ivHex, tagHex, encHex] = stored.split(':');
    if (!ivHex || !tagHex || !encHex) return null;
    const key = deriveKey();
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return null; // Not AES-encrypted (legacy bcrypt hash)
  }
}

function isAesEncrypted(stored: string): boolean {
  // AES format has two colons: iv:tag:encrypted
  return stored.split(':').length === 3;
}

function isArgon2Hash(stored: string): boolean {
  return stored.startsWith('$argon2id$');
}

// Each Argon2 operation uses at most 19 MiB. A two-slot process-local semaphore
// bounds concurrent hashes AND verification near 38 MiB/process, regardless of
// UV_THREADPOOL_SIZE. The slot transfers directly to the next waiter on release.
export const PASSWORD_HASH_OPTIONS = { type: argon2.argon2id, memoryCost: 19 * 1024, timeCost: 2, parallelism: 1 } as const;
let activePasswordHashes = 0;
const waitingPasswordHashes: Array<() => void> = [];
async function withPasswordHashSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activePasswordHashes < 2) activePasswordHashes++;
  else await new Promise<void>(resolve => waitingPasswordHashes.push(resolve));
  try { return await run(); }
  finally {
    const next = waitingPasswordHashes.shift();
    if (next) next(); // transfer the reserved slot; do not open it for a new arrival
    else activePasswordHashes--;
  }
}
export async function hashPassword(password: string): Promise<string> {
  return withPasswordHashSlot(() => argon2.hash(password, PASSWORD_HASH_OPTIONS));
}

// Legacy AES/bcrypt are accepted only as reads; all new writes use Argon2id.
export async function verifyStoredPassword(password: string, stored: string): Promise<boolean> {
  if (isArgon2Hash(stored)) {
    try {
      return await withPasswordHashSlot(() => argon2.verify(stored, password));
    } catch {
      return false;
    }
  }
  if (isAesEncrypted(stored)) {
    return decryptPassword(stored) === password;
  }
  // bcryptjs yields between work chunks; do not block the entire verification
  // in one synchronous call. This does not move hashing to a worker thread.
  return await bcrypt.compare(password, stored);
}

// ───── JWT ─────

export function generateToken(payload: JwtPayload, options?: { maxAgeSeconds: number }): string {
  if (options && (!Number.isInteger(options.maxAgeSeconds) || options.maxAgeSeconds < 60 || options.maxAgeSeconds > 900)) throw new Error('invalid_short_session_expiry');
  return jwt.sign(payload, config.jwtSecret, { expiresIn: options ? options.maxAgeSeconds : config.tokenExpiry as any });
}

/**
 * Generate a scoped, short-lived token for a specific subsystem.
 *
 * Use this for any context where the recipient should NOT have full user
 * access, e.g. fleet service tokens.
 *
 * Returned token:
 *   - has `aud` claim → authMiddleware will reject non-matching routes
 *   - has short expiration (default 15 min) → leak window minimized
 *   - same userId/username/role for audit trail
 */
export function generateScopedToken(
  payload: JwtPayload,
  opts: { aud: string; expiresIn?: string | number },
): string {
  const scopedPayload: JwtPayload = { ...payload, aud: opts.aud };
  return jwt.sign(scopedPayload, config.jwtSecret, {
    expiresIn: (opts.expiresIn ?? '15m') as any,
  });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, config.jwtSecret) as JwtPayload;
  } catch {
    return null;
  }
}

// ───── Scope registry (audience claim) ─────
// Tokens with `aud` are scoped — they can only hit router-relative paths
// matching one of the prefixes. Used by authMiddleware + admin endpoints
// for validation. Add new scopes here.
//
// Add to AUDITED_SCOPES if the scope is long-lived enough to warrant a DB
// audit row in service_tokens (revocation, last_used_at).
//
// 결정: workspace/decisions/2026-05-27-fleet-service-tokens.md
export const SCOPE_PREFIXES: Record<string, string[]> = {
  fleet: ['/sessions', '/schedules', '/projects', '/me'],
  'tower-cli': ['/me', '/projects', '/files', '/tasks'],
  // OAuth state is verified directly by the callback and must never authorize
  // a normal authenticated API route.
  'google-oauth-state': [],
};

export const AUDITED_SCOPES = new Set<string>(['fleet']);

export function isKnownScope(aud: string): boolean {
  return aud in SCOPE_PREFIXES;
}

/**
 * Segment-aware prefix match. `/sessions` allows `/sessions` and
 * `/sessions/anything` but NOT `/sessions-extra`. Trailing slash on the
 * stored prefix is ignored.
 */
export function pathMatchesScopePrefix(routerPath: string, prefix: string): boolean {
  const p = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return routerPath === p || routerPath.startsWith(p + '/');
}

// ───── User CRUD ─────

/**
 * Username validation — demo-org 같은 일괄 마이그레이션도 이 규칙을 통과해야 한다.
 *   - 소문자/숫자/`.`/`_`/`-` 만, 2~40자.
 *   - 첫 글자는 영문/숫자 (현재 db 의 `01020268080` 등 숫자 시작 username 호환).
 * 결정: workspace/decisions/2026-05-20-members-name-affiliation-and-credentials.md
 */
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/;

export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`Username '${username}' is already taken`);
    this.name = 'UsernameTakenError';
  }
}

export class InvalidUsernameError extends Error {
  constructor(username: string) {
    super(`Invalid username '${username}'. Must match ${USERNAME_RE} (lowercase, digits, ._-, 2-40 chars).`);
    this.name = 'InvalidUsernameError';
  }
}

export class UserManagementForbiddenError extends Error {
  constructor() { super('Only admins can modify privileged accounts'); this.name = 'UserManagementForbiddenError'; }
}

export interface CreateUserOpts {
  displayName?: string | null;
  affiliation?: string | null;
  approvalStatus?: 'active' | 'pending';
}

/**
 * Auto-join a user to the default projects that are meant to be visible at signup.
 * Kept as a shared helper so direct admin-created users and invite-code signups
 * get the same baseline workspace shape without joining opt-in workbench projects.
 */
export async function autoJoinDefaultProjects(userId: number, usernameForLog?: string, role = 'member'): Promise<number> {
  try {
    const { getDefaultProjectIds } = await import('../pm/project-manager.js');
    const { addProjectMember } = await import('../pm/project-membership-manager.js');
    const defaultIds = await getDefaultProjectIds(role);
    for (const pid of defaultIds) {
      await addProjectMember(pid, userId, 'member');
    }
    if (defaultIds.length > 0) {
      console.log(`[auth] Auto-joined user ${usernameForLog ?? userId} to ${defaultIds.length} default project(s)`);
    }
    return defaultIds.length;
  } catch (err) {
    console.warn('[auth] Failed to auto-join default projects:', err);
    return 0;
  }
}

export async function createUser(
  username: string,
  password: string,
  role = 'member',
  opts?: CreateUserOpts,
) {
  if (!USERNAME_RE.test(username)) {
    throw new InvalidUsernameError(username);
  }
  const encrypted = await hashPassword(password);
  const approvalStatus = opts?.approvalStatus ?? 'active';
  const row = await queryOne<{ id: number }>(
    `INSERT INTO users (username, password_hash, role, display_name, affiliation, approval_status, approved_at, password_changed_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 = 'active' THEN NOW() ELSE NULL END, NOW()) RETURNING id`,
    [username, encrypted, role, opts?.displayName ?? null, opts?.affiliation ?? null, approvalStatus],
  );
  const userId = row!.id;

  // Auto-join signup-visible default projects only. Organization/workbench projects
  // such as teamskills can exist as operator+ defaults without being all-user
  // invitations. 다른 active project 에 대한 auto-seed 는 폐기됨
  // (2026-05-04-five-role-model.md, section E).
  if (approvalStatus === 'active') {
    await autoJoinDefaultProjects(userId, username, role);
  }

  return { id: userId, username, role, approval_status: approvalStatus };
}

export type AuthFailureReason = 'invalid_credentials' | 'pending_approval' | 'rejected' | 'suspended';

export interface AuthResult {
  ok: boolean;
  payload?: JwtPayload;
  // Credential snapshot for deferred pre-session challenges; never include it in JWT payload.
  passwordChangedAt?: string | null;
  reason?: AuthFailureReason;
}

export async function recordAuthEvent(input: { userId?: number | null; username?: string | null; eventType: 'login_success' | 'login_failure' | 'logout'; ip?: string | null; userAgent?: string | null }) {
  try {
    await execute(
      'INSERT INTO auth_login_events (user_id, username, event_type, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
      [input.userId ?? null, input.username ?? null, input.eventType, input.ip ?? null, input.userAgent ?? null],
    );
  } catch (error) {
    // Login visibility must not make authentication unavailable before migration is applied.
    console.warn('[auth] failed to record auth event:', error);
  }
}

export async function authenticateUser(username: string, password: string, context?: { ip?: string | null; userAgent?: string | null; deferSuccess?: boolean }): Promise<AuthResult> {
  if (typeof username !== 'string' || username.length > 320 || !username.trim() || typeof password !== 'string') return { ok: false, reason: 'invalid_credentials' };
  const identifier = username.trim();
  // A verified primary identity is the only email alias. Resolve BOTH namespaces;
  // legacy/corrupt username collisions must never silently choose an account.
  const matches = await query<any>(
    `SELECT u.* FROM users u WHERE u.username = $1
       OR (u.primary_email_identity_id IS NOT NULL AND u.id IN
         (SELECT e.user_id FROM account_email_identities e
           WHERE e.email_normalized = $2 AND e.state = 'verified' AND e.id = u.primary_email_identity_id))`,
    [identifier, identifier.toLowerCase()],
  );
  const user = matches.length === 1 && Number(matches[0].disabled) === 0 ? matches[0] : undefined;
  if (!user) {
    await recordAuthEvent({ username, eventType: 'login_failure', ...context });
    return { ok: false, reason: 'invalid_credentials' };
  }

  const approvalStatus = user.approval_status || 'active';
  if (approvalStatus === 'pending') {
    await recordAuthEvent({ userId: user.id, username: user.username, eventType: 'login_failure', ...context });
    return { ok: false, reason: 'pending_approval' };
  }
  if (approvalStatus === 'rejected') {
    await recordAuthEvent({ userId: user.id, username: user.username, eventType: 'login_failure', ...context });
    return { ok: false, reason: 'rejected' };
  }
  if (approvalStatus === 'suspended') {
    await recordAuthEvent({ userId: user.id, username: user.username, eventType: 'login_failure', ...context });
    return { ok: false, reason: 'suspended' };
  }
  if (approvalStatus !== 'active') {
    await recordAuthEvent({ userId: user.id, username: user.username, eventType: 'login_failure', ...context });
    return { ok: false, reason: 'invalid_credentials' };
  }

  const stored = user.password_hash;
  const ok = await verifyStoredPassword(password, stored);

  // CAS prevents a concurrent reset/disable from being overwritten by a late login.
  // Rehash does not advance password_changed_at: existing tokens remain compatible.
  let expectedHash = stored;
  if (ok && !isArgon2Hash(stored)) {
    const hashed = await hashPassword(password);
    const migrated = await execute(
      "UPDATE users SET password_hash = $1 WHERE id = $2 AND password_hash = $3 AND disabled = 0 AND approval_status = 'active'",
      [hashed, user.id, stored],
    );
    if (!migrated.changes) return { ok: false, reason: 'invalid_credentials' };
    expectedHash = hashed;
  }

  if (!ok) {
    await recordAuthEvent({ userId: user.id, username: user.username, eventType: 'login_failure', ...context });
    return { ok: false, reason: 'invalid_credentials' };
  }
  // Check the credential snapshot again even when no rehash was required.
  const current = await queryOne<{ password_hash: string; disabled: number; approval_status: string; auth_epoch: number; password_changed_at: string | null; primary_email_identity_id: number; alias_valid: boolean }>(
    `SELECT u.password_hash, u.disabled, u.approval_status, u.auth_epoch, u.password_changed_at, u.primary_email_identity_id,
       EXISTS (SELECT 1 FROM account_email_identities e WHERE e.id=u.primary_email_identity_id AND e.user_id=u.id AND e.state='verified' AND e.email_normalized=$2) AS alias_valid
       FROM users u WHERE u.id=$1`, [user.id, identifier.toLowerCase()],
  );
  if (identifier !== user.username && !current?.alias_valid) return { ok: false, reason: 'invalid_credentials' };
  // A verified email can become another user's username while password hashing runs.
  // Recheck both namespaces before accepting a stale alias resolution.
  if (identifier !== user.username) {
    const collision = await queryOne<{ id: number }>('SELECT id FROM users WHERE username=$1 AND id<>$2', [identifier, user.id]);
    if (collision) return { ok: false, reason: 'invalid_credentials' };
  }
  if (!current || current.password_hash !== expectedHash || Number(current.disabled) !== 0 || current.approval_status !== 'active'
      || Number(current.auth_epoch ?? 0) !== Number(user.auth_epoch ?? 0)) return { ok: false, reason: 'invalid_credentials' };
  if (!context?.deferSuccess) {
    await completeAuthenticationSuccess({ userId:user.id,username:user.username,ip:context?.ip,userAgent:context?.userAgent });
  }
  return { ok: true, payload: { userId: user.id, username: user.username, role: user.role, authEpoch: Number(current.auth_epoch) }, passwordChangedAt: current.password_changed_at ? new Date(current.password_changed_at).toISOString() : null };
}

export async function completeAuthenticationSuccess(input: { userId:number; username:string; ip?:string|null; userAgent?:string|null }): Promise<void> {
  const updated = await execute("UPDATE users SET last_login_at = NOW(), last_login_ip = $1 WHERE id = $2 AND disabled = 0 AND approval_status = 'active'", [input.ip ?? null,input.userId]);
  if (!updated.changes) throw new Error('Account is no longer active');
  await recordAuthEvent({userId:input.userId,username:input.username,eventType:'login_success',ip:input.ip,userAgent:input.userAgent});
}

export async function hasUsers(): Promise<boolean> {
  const row = await queryOne<{ count: string }>('SELECT COUNT(*) as count FROM users WHERE disabled = 0');
  return Number(row!.count) > 0;
}

export function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  const queryToken = req.query?.token as string | undefined;
  if (queryToken) return queryToken;
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/(?:^|;\s*)tower_token=([^;]+)/);
  if (match) return match[1];
  return null;
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!config.authEnabled) return next();

  const rawToken = extractToken(req);

  if (!rawToken) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const payload = verifyToken(rawToken);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  let effectivePayload = payload;

  // ── Account state + token freshness check ──
  // Every token type is denied immediately when the backing user is disabled.
  // Browser tokens are also rejected after password/username changes.
  // Browser token role is refreshed from DB so long-lived tabs do not keep stale
  // admin/operator capabilities after account-role changes.
  if (payload.userId) {
    try {
      const state = await getUserAuthState(payload.userId);
      if (!state || state.disabled || state.approvalStatus !== 'active' || Number(payload.authEpoch ?? 0) !== state.authEpoch) {
        return res.status(401).json({ error: 'Account disabled or inactive' });
      }
      if (!payload.aud) {
        effectivePayload = { ...payload, role: state.role };
      }
      if (!payload.aud && (payload as any).iat) {
        const tokenIssuedAtMs = (payload as any).iat * 1000;
        // Allow a 2s grace window — JWT.iat is rounded to seconds, NOW() is
        // microseconds; a token issued in the same second as a credential
        // change must not be auto-invalidated.
        if (state.passwordChangedAt > tokenIssuedAtMs + 2000) {
          return res.status(401).json({ error: 'Token invalidated by credential change' });
        }
      }
    } catch (err) {
      // Account revocation is a security boundary. Do not let a DB/cache error
      // silently preserve access for a disabled principal.
      console.warn('[auth] account-state check failed:', err);
      return res.status(503).json({ error: 'Authentication state unavailable' });
    }
  }

  // ── Scope enforcement (audience claim) ──
  // Tokens with `aud` are scoped — they can only access routes matching
  // the audience. Tokens without `aud` have full access (browser sessions).
  // Scopes:
  //   'ideas' — SDK-injected pm-capture (15min). No DB audit.
  //   'fleet' — long-lived (90d) operator → self-hosted server. DB audit in
  //             service_tokens. See decisions/2026-05-27-fleet-service-tokens.md.
  if (payload.aud) {
    const allowedPrefixes = SCOPE_PREFIXES[payload.aud];
    if (!allowedPrefixes) {
      return res.status(403).json({ error: `Unknown token scope: ${payload.aud}` });
    }
    // req.path is the path within this router (mounted at /api), so we
    // compare against the router-relative prefix.
    const routerPath = req.path; // e.g. "/sessions/abc" or "/projects"
    const allowed = allowedPrefixes.some((p) => pathMatchesScopePrefix(routerPath, p));
    if (!allowed) {
      return res.status(403).json({
        error: `Token scope '${payload.aud}' does not allow access to ${routerPath}`,
      });
    }
    // For audited scopes (fleet et al.): check DB for revocation, then
    // throttle-update last_used_at. Unknown jti is allowed (defers to JWT
    // verification) — only known-and-revoked is denied.
    if (AUDITED_SCOPES.has(payload.aud) && (payload as any).jti) {
      const jti = (payload as any).jti as string;
      try {
        const { isJtiRevoked, touchServiceToken } = await import('./service-tokens.js');
        if (await isJtiRevoked(jti)) {
          return res.status(401).json({ error: 'Token revoked' });
        }
        // Fire-and-forget touch — no need to await, throttled internally.
        void touchServiceToken(jti).catch((err) => {
          console.warn('[auth] touchServiceToken failed:', err);
        });
      } catch (err) {
        // Fail-open on DB blip — same policy as freshness check above.
        console.warn('[auth] service-tokens check failed (continuing):', err);
      }
    }
  }

  // Cookie sync: if authenticated via header/query but no cookie yet, set it.
  // This ensures the browser always has the httpOnly cookie for Nginx auth_request
  // (e.g., when opening /hub/ in a new tab where Authorization header isn't sent).
  //
  // SECURITY: scoped tokens (with aud) MUST NOT be cookie-synced — they're
  // short-lived subsystem credentials, not session tokens. If we synced them
  // to a 90-day cookie, the leak window expands dramatically.
  const cookies = req.headers.cookie || '';
  if (!payload.aud && !cookies.includes('tower_token=')) {
    res.cookie('tower_token', rawToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days
    });
  }

  (req as any).user = effectivePayload;
  next();
}

// ───── Admin user management ─────

export async function listUsers() {
  const rows = await query<any>(
    `SELECT u.id, u.username, u.role, u.disabled,
            u.display_name, u.affiliation, u.created_at, u.last_login_at, u.last_login_ip,
            u.approval_status, u.approved_at, u.rejected_at, u.rejection_reason,
            ei.email AS account_email,
            ei.state AS account_email_status,
            ic.id AS signup_invite_code_id,
            ic.code AS signup_invite_code,
            ic.label AS signup_invite_label,
            COALESCE(project_access.projects, '[]'::json) AS projects
       FROM users u
       LEFT JOIN signup_invite_codes ic ON ic.id = u.signup_invite_code_id
       LEFT JOIN LATERAL (
         SELECT email, state
           FROM account_email_identities
          WHERE user_id = u.id AND state IN ('verified','pending')
          ORDER BY CASE WHEN state = 'verified' THEN 0 ELSE 1 END, created_at DESC
          LIMIT 1
       ) ei ON TRUE
       LEFT JOIN LATERAL (
         SELECT json_agg(DISTINCT jsonb_build_object('id', p.id, 'name', p.name, 'role', pm.role)) AS projects
           FROM project_members pm
           JOIN projects p ON p.id = pm.project_id AND (p.archived IS NULL OR p.archived = 0)
          WHERE pm.user_id = u.id
       ) project_access ON TRUE
      ORDER BY u.id`
  );

  return rows.map(r => ({
    id: r.id,
    username: r.username,
    role: r.role,
    disabled: Number(r.disabled) === 1,
    approval_status: r.approval_status || 'active',
    display_name: r.display_name,
    affiliation: r.affiliation,
    account_email: r.account_email ?? null,
    account_email_status: r.account_email_status ?? 'missing',
    signup_invite_code_id: r.signup_invite_code_id,
    signup_invite_code: r.signup_invite_code,
    signup_invite_label: r.signup_invite_label,
    approved_at: r.approved_at,
    rejected_at: r.rejected_at,
    rejection_reason: r.rejection_reason,
    projects: r.projects || [],
    last_login_at: r.last_login_at ?? null,
    last_login_ip: r.last_login_ip ?? null,
    created_at: r.created_at,
  }));
}

/** 본인 프로필 조회 — UserMenu / GET /api/me 가 사용. */
export async function getOwnProfile(userId: number) {
  const row = await queryOne<any>(
    'SELECT id, username, role, display_name, affiliation, language FROM users WHERE id = $1 AND disabled = 0',
    [userId],
  );
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    display_name: row.display_name,
    affiliation: row.affiliation,
    language: row.language,
  };
}

export async function updateUserRole(userId: number, role: string, actorRole: 'admin' | 'operator'): Promise<boolean> {
  if (!VALID_ROLES.has(role)) {
    throw new Error(`Invalid role: ${role}. Valid roles: ${[...VALID_ROLES].join(', ')}`);
  }
  // PostgreSQL rechecks this predicate after waiting on a concurrent role promotion.
  // An operator must not downgrade a user who has since become admin/operator.
  if (actorRole === 'operator' && !['member', 'viewer', 'guest'].includes(role)) return false;
  const updated = await execute(actorRole === 'admin'
    ? 'UPDATE users SET role = $1 WHERE id = $2'
    : "UPDATE users SET role = $1 WHERE id = $2 AND role IN ('member', 'viewer', 'guest')", [role, userId]);
  if (updated.changes) invalidateAuthCache(userId);
  return !!updated.changes;
}

/**
 * Deprecated: per-user work directories are no longer part of the active access
 * model. Access is derived from global role + project membership instead.
 * Kept only so old imports fail loudly if reintroduced.
 */
export async function updateUserPath(_userId: number, _allowedPath: string) {
  throw new Error('updateUserPath is deprecated; use role + project membership access instead');
}

/**
 * 사용자 이름·소속 갱신. admin/operator 가 다른 사용자에게 또는 사용자 본인이 본인에게.
 * 값이 null/'' 이면 비움 (NULL 로 저장). undefined 면 그 컬럼 안 건드림.
 */
export async function updateUserProfile(
  userId: number,
  fields: { displayName?: string | null; affiliation?: string | null; language?: 'en' | 'ko' | null },
  actorRole?: 'admin' | 'operator',
): Promise<boolean> {
  const sets: string[] = [];
  const vals: any[] = [];
  let i = 1;
  if (fields.displayName !== undefined) {
    sets.push(`display_name = $${i++}`);
    vals.push(fields.displayName === '' ? null : fields.displayName);
  }
  if (fields.affiliation !== undefined) {
    sets.push(`affiliation = $${i++}`);
    vals.push(fields.affiliation === '' ? null : fields.affiliation);
  }
  if (fields.language !== undefined) {
    if (fields.language !== null && fields.language !== 'en' && fields.language !== 'ko') {
      throw new Error(`Invalid response language: ${String(fields.language)}`);
    }
    sets.push(`language = $${i++}`);
    vals.push(fields.language);
  }
  if (sets.length === 0) return true;
  vals.push(userId);
  const roleCondition = actorRole === 'operator' ? " AND role IN ('member', 'viewer', 'guest')" : '';
  const updated = await execute(`UPDATE users SET ${sets.join(', ')} WHERE id = $${i}${roleCondition}`, vals);
  return !!updated.changes;
}

/**
 * Username 변경 — admin only 진입점이지만 함수 자체는 권한 체크 안 함 (호출자가 가드).
 *
 * 동작:
 *   1. validate (USERNAME_RE) — invalid 면 InvalidUsernameError.
 *   2. UNIQUE 충돌 사전 확인 — 충돌 시 UsernameTakenError.
 *   3. TRANSACTION:
 *      - users.username 갱신 + password_changed_at = NOW() (토큰 invalidate).
 *      - user_username_history 에 audit row 추가.
 *   4. 파일시스템 (트랜잭션 밖, best-effort):
 *      workspace/projects/_team/people/<old>.md → <new>.md rename.
 *   5. authCache 무효화.
 *
 * 결정: workspace/decisions/2026-05-20-members-name-affiliation-and-credentials.md
 */
export async function updateUserUsername(
  userId: number,
  newUsername: string,
  changedBy: number | null,
  opts?: { reason?: string | null; actorRole?: 'admin' | 'operator' },
): Promise<{ oldUsername: string; newUsername: string }> {
  if (!USERNAME_RE.test(newUsername)) {
    throw new InvalidUsernameError(newUsername);
  }
  const oldUsername = await transaction(async (client) => {
    const current = (await client.query<{ username: string; role: string }>(
      'SELECT username, role FROM users WHERE id = $1 FOR UPDATE', [userId],
    )).rows[0];
    if (!current) throw new Error(`User ${userId} not found`);
    if (opts?.actorRole === 'operator' && !['member', 'viewer', 'guest'].includes(current.role)) throw new UserManagementForbiddenError();
    if (current.username === newUsername) return current.username;
    const conflict = (await client.query<{ id: number }>(
      'SELECT id FROM users WHERE username = $1 AND id != $2', [newUsername, userId],
    )).rows[0];
    if (conflict) throw new UsernameTakenError(newUsername);
    await client.query(
      'UPDATE users SET username = $1, password_changed_at = NOW(), auth_epoch = auth_epoch + 1 WHERE id = $2',
      [newUsername, userId],
    );
    await client.query(
      'INSERT INTO user_username_history (user_id, old_username, new_username, changed_by, reason) VALUES ($1, $2, $3, $4, $5)',
      [userId, current.username, newUsername, changedBy, opts?.reason ?? null],
    );
    return current.username;
  });
  if (oldUsername === newUsername) return { oldUsername, newUsername };

  // FS rename — workspace/projects/_team/people/<u>.md
  try {
    const peopleDir = path.join(
      os.homedir(),
      'workspace',
      'projects',
      '_team',
      'people',
    );
    const oldPath = path.join(peopleDir, `${oldUsername}.md`);
    const newPath = path.join(peopleDir, `${newUsername}.md`);
    if (existsSync(oldPath) && !existsSync(newPath)) {
      await fs.rename(oldPath, newPath);
      console.log(`[auth] Renamed people profile: ${oldUsername}.md → ${newUsername}.md`);
    }
  } catch (err) {
    console.warn('[auth] Failed to rename people profile (DB updated successfully):', err);
  }

  invalidateAuthCache(userId);
  return { oldUsername, newUsername };
}

/**
 * 사용자 본인이 자기 비밀번호 변경. 옛 비번 인증 필요.
 * - ok=true: 성공, password_changed_at 갱신 → 다른 기기 자동 로그아웃.
 * - ok=false: 옛 비번 틀림 또는 사용자 disabled.
 */
export async function changeOwnPassword(
  userId: number,
  oldPassword: string,
  newPassword: string,
): Promise<boolean> {
  const user = await queryOne<any>(
    'SELECT username, password_hash FROM users WHERE id = $1 AND disabled = 0',
    [userId],
  );
  if (!user) return false;

  const stored = user.password_hash;
  const ok = await verifyStoredPassword(oldPassword, stored);
  if (!ok) return false;

  const encrypted = await hashPassword(newPassword);
  const changed = await execute(
    'UPDATE users SET password_hash = $1, password_changed_at = NOW(), auth_epoch = auth_epoch + 1 WHERE id = $2 AND password_hash = $3 AND disabled = 0',
    [encrypted, userId, stored],
  );
  if (!changed.changes) return false;
  invalidateAuthCache(userId);
  return true;
}

export async function resetUserPassword(userId: number, newPassword: string) {
  const encrypted = await hashPassword(newPassword);
  const updated = await execute(
    'UPDATE users SET password_hash = $1, password_changed_at = NOW(), auth_epoch = auth_epoch + 1 WHERE id = $2 AND disabled = 0',
    [encrypted, userId],
  );
  if (updated.changes) invalidateAuthCache(userId);
}

export async function disableUser(userId: number, actorRole: 'admin' | 'operator', actorUserId: number): Promise<'disabled' | 'not_found' | 'forbidden'> {
  const result = await transaction(async client => {
    const target = (await client.query<{ role: string }>('SELECT role FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
    if (!target) return 'not_found' as const;
    if (actorUserId === userId || (actorRole !== 'admin' && !['member', 'viewer', 'guest'].includes(target.role))) return 'forbidden' as const;
    await client.query('UPDATE users SET disabled = 1, password_changed_at = NOW() WHERE id = $1', [userId]);
    await client.query("UPDATE auth_login_otp_challenges SET status = 'cancelled' WHERE user_id = $1 AND status = 'pending'", [userId]);
    await client.query("UPDATE auth_login_email_enrollments SET status = 'cancelled' WHERE user_id = $1 AND status = 'pending'", [userId]);
    return 'disabled' as const;
  });
  if (result === 'disabled') invalidateAuthCache(userId);
  return result;
}

// ───── Account-state cache ─────
// HTTP/WS authentication checks disabled + approval state as well as credential
// freshness. Mutation paths invalidate this cache so revocation is immediate in
// the current process; the short TTL bounds cross-process propagation.
interface AuthCacheEntry {
  passwordChangedAt: number;
  disabled: boolean;
  approvalStatus: string;
  role: string;
  authEpoch: number;
  cachedAt: number;
}
const AUTH_CACHE_TTL_MS = 5 * 1000;
const authCache = new Map<number, AuthCacheEntry>();
const authReads = new Map<number, { invalidated: boolean; promise: Promise<UserAuthState | null> }>();

export function invalidateAuthCache(userId: number) {
  authCache.delete(userId);
  const pending = authReads.get(userId);
  if (pending) pending.invalidated = true;
  authReads.delete(userId);
}

export interface UserAuthState {
  passwordChangedAt: number;
  disabled: boolean;
  approvalStatus: string;
  role: string;
  authEpoch: number;
}

/** Return the current account state used by both HTTP and WebSocket auth. */
export async function getUserAuthState(userId: number): Promise<UserAuthState | null> {
  // Recheck after awaiting: invalidation can happen even after SQL resolves but
  // before an authentication caller consumes the result. Bound retries under
  // repeated mutations; exhaustion throws and the middleware fails closed.
  for (let attempt = 0; attempt < 3; attempt++) {
    const cached = authCache.get(userId);
    if (cached && Date.now() - cached.cachedAt < AUTH_CACHE_TTL_MS) return cached;
    let pending = authReads.get(userId);
    if (!pending) {
      const entry = { invalidated: false, promise: null! as Promise<UserAuthState | null> };
      entry.promise = Promise.resolve().then(() => readUserAuthState(userId, Date.now(), () => entry.invalidated));
      authReads.set(userId, entry);
      pending = entry;
    }
    try {
      const state = await pending.promise;
      if (!pending.invalidated) return state;
    } finally {
      if (authReads.get(userId) === pending) authReads.delete(userId);
    }
  }
  throw new Error('Account state changed repeatedly during authentication');
}

async function readUserAuthState(userId: number, now: number, isInvalidated: () => boolean): Promise<UserAuthState | null> {
  const row = await queryOne<{
    password_changed_at: string | null;
    disabled: number | boolean;
    approval_status: string | null;
    role: string | null;
    auth_epoch: number;
  }>(
    'SELECT password_changed_at, disabled, approval_status, role, auth_epoch FROM users WHERE id = $1',
    [userId],
  );
  if (!row) return null;
  const state: AuthCacheEntry = {
    passwordChangedAt: row.password_changed_at ? new Date(row.password_changed_at).getTime() : 0,
    disabled: row.disabled === true || Number(row.disabled) === 1,
    approvalStatus: row.approval_status || 'active',
    role: row.role || 'member',
    authEpoch: Number(row.auth_epoch ?? 0),
    cachedAt: now,
  };
  if (!isInvalidated()) authCache.set(userId, state);
  return state;
}

/**
 * Lookup a user's role. Returns null if user doesn't exist.
 * Used by routes that need to gate operator actions on admin targets
 * (operator 가 admin 사용자를 비활성화·역할변경하려는 시도 차단).
 */
export async function getUserRole(userId: number): Promise<string | null> {
  const row = await queryOne<{ role: string }>(
    'SELECT role FROM users WHERE id = $1',
    [userId],
  );
  return row?.role ?? null;
}

/**
 * Returns the broad legacy filesystem root for APIs/engines that still accept a
 * single `allowedPath`. This no longer reads `users.allowed_path`.
 *
 * Active access enforcement is project-centric:
 *   - admin/operator      → workspace root
 *   - member/guest/viewer → workspace/projects/ as a coarse root,
 *                                      then project_membership/access guards
 *                                      narrow it to invited projects
 *
 * Keep this function only as a compatibility bridge while older file APIs are
 * being migrated to `getUserAccessiblePaths()`.
 */
export async function getUserAllowedPath(userId: number): Promise<string> {
  const row = await queryOne<{ role: string | null }>(
    'SELECT role FROM users WHERE id = $1',
    [userId],
  );
  const role = row?.role || 'member';
  if (role === 'admin' || role === 'operator') {
    return config.workspaceRoot;
  }
  // member / guest / viewer / unknown → restrict to projects/ by default
  return path.join(config.workspaceRoot, 'projects');
}

/**
 * adminMiddleware — *strictly* admin only. Use for actions that must never
 * be delegated (system configuration, model management, prompt editing, etc.).
 * For user-management actions that operator may also perform, use
 * `operatorOrAboveMiddleware`.
 */
export function adminMiddleware(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user;
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * operatorOrAboveMiddleware — admin OR operator. Use for actions that are
 * legitimately delegated to a customer-side operator (사용자 초대·비활성·
 * 역할변경, 모든 프로젝트의 멤버 add/remove, etc.).
 *
 * Note: 일부 세부 동작은 *추가* admin-only 가드를 받는다 (예: admin 역할
 * 부여·박탈은 라우트 핸들러 내부에서 별도 체크).
 *
 * 결정: workspace/decisions/2026-05-04-five-role-model.md
 */
export function operatorOrAboveMiddleware(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user;
  if (!user || (user.role !== 'admin' && user.role !== 'operator')) {
    return res.status(403).json({ error: 'Admin or operator access required' });
  }
  next();
}

/** Verify a WS token and reject disabled/inactive users or stale browser JWTs. */
export async function verifyWsToken(token: string | null): Promise<JwtPayload | null> {
  if (!config.authEnabled) return { userId: 0, username: 'anonymous', role: 'admin' };
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload?.userId) return null;
  const state = await getUserAuthState(payload.userId);
  if (!state || state.disabled || state.approvalStatus !== 'active' || Number(payload.authEpoch ?? 0) !== state.authEpoch) return null;
  if (!payload.aud && (payload as any).iat) {
    const tokenIssuedAtMs = (payload as any).iat * 1000;
    if (state.passwordChangedAt > tokenIssuedAtMs + 2000) return null;
  }
  return payload.aud ? payload : { ...payload, role: state.role };
}
