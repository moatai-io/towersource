import crypto from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import bcrypt from 'bcryptjs';
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
}

// ───── AES-256-GCM Encryption ─────

const ALGO = 'aes-256-gcm';

function deriveKey(): Buffer {
  // Derive a 32-byte key from JWT secret using SHA-256
  return crypto.createHash('sha256').update(config.jwtSecret).digest();
}

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

// ───── Legacy bcrypt (for migration) ─────

function verifyBcrypt(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

// ───── JWT ─────

export function generateToken(payload: JwtPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.tokenExpiry as any });
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

export interface CreateUserOpts {
  displayName?: string | null;
  affiliation?: string | null;
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
  const encrypted = encryptPassword(password);
  const row = await queryOne<{ id: number }>(
    'INSERT INTO users (username, password_hash, role, display_name, affiliation, password_changed_at) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id',
    [username, encrypted, role, opts?.displayName ?? null, opts?.affiliation ?? null],
  );
  const userId = row!.id;

  // Auto-join signup-visible default projects only. Organization/workbench projects
  // such as teamskills can exist as operator+ defaults without being all-user
  // invitations. 다른 active project 에 대한 auto-seed 는 폐기됨
  // (2026-05-04-five-role-model.md, section E).
  await autoJoinDefaultProjects(userId, username, role);

  return { id: userId, username, role };
}

export type AuthFailureReason = 'invalid_credentials' | 'pending_approval' | 'rejected' | 'suspended';

export interface AuthResult {
  ok: boolean;
  payload?: JwtPayload;
  reason?: AuthFailureReason;
}

export async function authenticateUser(username: string, password: string): Promise<AuthResult> {
  const user = await queryOne<any>(
    'SELECT * FROM users WHERE username = $1 AND disabled = 0',
    [username]
  );
  if (!user) return { ok: false, reason: 'invalid_credentials' };

  const approvalStatus = user.approval_status || 'active';
  if (approvalStatus === 'pending') return { ok: false, reason: 'pending_approval' };
  if (approvalStatus === 'rejected') return { ok: false, reason: 'rejected' };
  if (approvalStatus === 'suspended') return { ok: false, reason: 'suspended' };
  if (approvalStatus !== 'active') return { ok: false, reason: 'invalid_credentials' };

  const stored = user.password_hash;
  let ok = false;

  if (isAesEncrypted(stored)) {
    // New AES path
    const decrypted = decryptPassword(stored);
    ok = decrypted === password;
  } else {
    // Legacy bcrypt fallback
    ok = verifyBcrypt(password, stored);
    // Auto-migrate to AES on successful login
    if (ok) {
      const encrypted = encryptPassword(password);
      await execute('UPDATE users SET password_hash = $1 WHERE id = $2', [encrypted, user.id]);
    }
  }

  if (!ok) return { ok: false, reason: 'invalid_credentials' };
  return { ok: true, payload: { userId: user.id, username: user.username, role: user.role } };
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
      if (!state || state.disabled || state.approvalStatus !== 'active') {
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
    `SELECT u.id, u.username, u.role, u.password_hash,
            u.display_name, u.affiliation, u.created_at,
            u.approval_status, u.approved_at, u.rejected_at, u.rejection_reason,
            ic.id AS signup_invite_code_id,
            ic.code AS signup_invite_code,
            ic.label AS signup_invite_label,
            COALESCE(
              json_agg(DISTINCT jsonb_build_object('id', c.id, 'name', c.customer_name))
                FILTER (WHERE c.id IS NOT NULL),
              '[]'::json
            ) AS customer_vms,
            COALESCE(
              json_agg(DISTINCT jsonb_build_object('id', p.id, 'name', p.name, 'role', pm.role))
                FILTER (WHERE p.id IS NOT NULL),
              '[]'::json
            ) AS projects
       FROM users u
       LEFT JOIN signup_invite_codes ic ON ic.id = u.signup_invite_code_id
       LEFT JOIN user_customer_vms ucv ON ucv.user_id = u.id
       LEFT JOIN gateway_customers c ON c.id = ucv.customer_id
       LEFT JOIN project_members pm ON pm.user_id = u.id
       LEFT JOIN projects p ON p.id = pm.project_id AND (p.archived IS NULL OR p.archived = 0)
      WHERE u.disabled = 0
      GROUP BY u.id, ic.id
      ORDER BY u.id`
  );

  return rows.map(r => ({
    id: r.id,
    username: r.username,
    role: r.role,
    approval_status: r.approval_status || 'active',
    display_name: r.display_name,
    affiliation: r.affiliation,
    signup_invite_code_id: r.signup_invite_code_id,
    signup_invite_code: r.signup_invite_code,
    signup_invite_label: r.signup_invite_label,
    approved_at: r.approved_at,
    rejected_at: r.rejected_at,
    rejection_reason: r.rejection_reason,
    customer_vms: r.customer_vms || [],
    projects: r.projects || [],
    // Decrypt password for admin view; show empty for legacy bcrypt
    password_plain: isAesEncrypted(r.password_hash) ? decryptPassword(r.password_hash) || '' : '',
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

export async function updateUserRole(userId: number, role: string) {
  if (!VALID_ROLES.has(role)) {
    throw new Error(`Invalid role: ${role}. Valid roles: ${[...VALID_ROLES].join(', ')}`);
  }
  await execute('UPDATE users SET role = $1 WHERE id = $2', [role, userId]);
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
) {
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
  if (sets.length === 0) return;
  vals.push(userId);
  await execute(`UPDATE users SET ${sets.join(', ')} WHERE id = $${i}`, vals);
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
  opts?: { reason?: string | null },
): Promise<{ oldUsername: string; newUsername: string }> {
  if (!USERNAME_RE.test(newUsername)) {
    throw new InvalidUsernameError(newUsername);
  }
  const current = await queryOne<{ username: string }>(
    'SELECT username FROM users WHERE id = $1',
    [userId],
  );
  if (!current) throw new Error(`User ${userId} not found`);
  const oldUsername = current.username;
  if (oldUsername === newUsername) return { oldUsername, newUsername };

  const conflict = await queryOne<{ id: number }>(
    'SELECT id FROM users WHERE username = $1 AND id != $2',
    [newUsername, userId],
  );
  if (conflict) throw new UsernameTakenError(newUsername);

  await transaction(async (client) => {
    await client.query(
      'UPDATE users SET username = $1, password_changed_at = NOW() WHERE id = $2',
      [newUsername, userId],
    );
    await client.query(
      'INSERT INTO user_username_history (user_id, old_username, new_username, changed_by, reason) VALUES ($1, $2, $3, $4, $5)',
      [userId, oldUsername, newUsername, changedBy, opts?.reason ?? null],
    );
  });

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
  let ok = false;
  if (isAesEncrypted(stored)) {
    ok = decryptPassword(stored) === oldPassword;
  } else {
    ok = verifyBcrypt(oldPassword, stored);
  }
  if (!ok) return false;

  const encrypted = encryptPassword(newPassword);
  await execute(
    'UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2',
    [encrypted, userId],
  );
  invalidateAuthCache(userId);
  return true;
}

export async function resetUserPassword(userId: number, newPassword: string) {
  const encrypted = encryptPassword(newPassword);
  await execute(
    'UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2',
    [encrypted, userId],
  );
  invalidateAuthCache(userId);
}

export async function disableUser(userId: number) {
  await execute(
    'UPDATE users SET disabled = 1, password_changed_at = NOW() WHERE id = $1',
    [userId],
  );
  invalidateAuthCache(userId);
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
  cachedAt: number;
}
const AUTH_CACHE_TTL_MS = 5 * 1000;
const authCache = new Map<number, AuthCacheEntry>();

export function invalidateAuthCache(userId: number) {
  authCache.delete(userId);
}

export interface UserAuthState {
  passwordChangedAt: number;
  disabled: boolean;
  approvalStatus: string;
  role: string;
}

/** Return the current account state used by both HTTP and WebSocket auth. */
export async function getUserAuthState(userId: number): Promise<UserAuthState | null> {
  const now = Date.now();
  const cached = authCache.get(userId);
  if (cached && now - cached.cachedAt < AUTH_CACHE_TTL_MS) {
    return cached;
  }
  const row = await queryOne<{
    password_changed_at: string | null;
    disabled: number | boolean;
    approval_status: string | null;
    role: string | null;
  }>(
    'SELECT password_changed_at, disabled, approval_status, role FROM users WHERE id = $1',
    [userId],
  );
  if (!row) return null;
  const state: AuthCacheEntry = {
    passwordChangedAt: row.password_changed_at ? new Date(row.password_changed_at).getTime() : 0,
    disabled: row.disabled === true || Number(row.disabled) === 1,
    approvalStatus: row.approval_status || 'active',
    role: row.role || 'member',
    cachedAt: now,
  };
  authCache.set(userId, state);
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
 *   - admin/operator/customer_manager → workspace root
 *   - member/guest/viewer             → workspace/projects/ as a coarse root,
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
  if (role === 'admin' || role === 'operator' || role === 'customer_manager') {
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
  if (!state || state.disabled || state.approvalStatus !== 'active') return null;
  if (!payload.aud && (payload as any).iat) {
    const tokenIssuedAtMs = (payload as any).iat * 1000;
    if (state.passwordChangedAt > tokenIssuedAtMs + 2000) return null;
  }
  return payload.aud ? payload : { ...payload, role: state.role };
}
