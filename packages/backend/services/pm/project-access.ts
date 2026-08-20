/**
 * Project-centric access control.
 *
 * Core principle: "사람 기준 접근 제어" (refined 2026-05-02)
 * - AI가 접근 가능한 폴더 = 그 사용자가 멤버인 모든 프로젝트의 root_path
 * - admin / operator → 전체 접근 (workspace 루트 포함)
 * - member → 자신이 멤버인 모든 프로젝트 + READ_PUBLIC_DIRS read/write
 * - viewer / guest → 자신이 접근 가능한 프로젝트 + READ_PUBLIC_DIRS read-only
 * - decisions / docs → member 이상 write, viewer/guest read-only
 * - uploads / published → admin/operator only (멤버는 PublishPanel / 자기 프로젝트 안 uploads/)
 *
 * 결정: workspace/decisions/2026-05-02-workspace-root-isolation.md
 *      (supersedes 2026-05-01-workspace-root-guard.md;
 *       amends 2026-04-18-session-scoped-write-guard.md)
 */

import path from 'path';
import { existsSync, realpathSync } from 'fs';
import { getAccessibleProjectIds, isProjectMember } from './project-membership-manager.js';
import { queryOne } from '../../db/pg-repo.js';
import { buildDamageControl, buildPathEnforcement, buildSecretGuard, type DamageCheckResult } from '../damage-control.js';
import { hasInternalShareAccess } from '../session/session-share-manager.js';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.join(process.env.HOME || '/tmp', 'workspace');
const TOWER_REPO_ROOT = path.resolve(process.env.TOWER_REPO_ROOT || path.join(process.env.HOME || '/tmp', 'tower'));

/**
 * Privileged trio — see workspace 전체 (루트 + 모든 프로젝트 + uploads/published READ).
 * admin/operator 는 Tower 전역, customer_manager 는 operator-host VM (TOWER_ROLE=full)
 * 한정으로 동일한 workspace 권한.
 *
 * Single source of truth for the "workspace-class" gate (used in 30+ places).
 *
 * ⚠️ Tower 전역 *관리* (decisions/docs write, AdminPanel, library publish, 모든 self-hosted server 접근)
 *    은 `isAdminOrOperator()` 를 쓴다 — customer_manager 는 자기 담당 customer 만 만진다.
 *
 * 결정: workspace/decisions/2026-05-27-operator-host-privileged-roles-and-cross-project-relaxation.md
 *      workspace/decisions/2026-05-23-customer-manager-role.md
 */
export function isPrivilegedRole(role: string | undefined | null): boolean {
  return role === 'admin' || role === 'operator' || role === 'customer_manager';
}

/**
 * Tower 전역 관리 권한 (admin + operator). customer_manager 는 *제외* —
 * customer_manager 는 자기 담당 self-hosted server 만 관리하며 Tower 전역 정책
 * (decisions/docs, AdminPanel, library publish, 모든 self-hosted server 운영) 의 주체가 아니다.
 *
 * 사용처:
 * - `decisions/`·`docs/` write gate
 * - AdminPanel API
 * - `library publish` (self-hosted server 으로 skill 배포)
 * - 모든 self-hosted server 에 대한 fleet status 등 (단 fleet 자체 호출은 privileged trio 모두 가능 — 결과 scope 만 user_customer_vms 로 필터)
 *
 * 결정: workspace/decisions/2026-05-27-operator-host-privileged-roles-and-cross-project-relaxation.md
 */
export function isAdminOrOperator(role: string | undefined | null): boolean {
  return role === 'admin' || role === 'operator';
}

/**
 * Shared knowledge dirs — everyone can READ. Members and above can WRITE;
 * viewer/guest remain read-only.
 */
const READ_PUBLIC_DIRS = [
  path.join(WORKSPACE_ROOT, 'docs'),
  path.join(WORKSPACE_ROOT, 'decisions'),
];

/**
 * Privileged dirs — admin/operator only for both READ and WRITE.
 * - uploads/ historically held cross-cutting attachments (contracts, screenshots).
 *   New uploads should go under projects/<p>/uploads/.
 * - published/ is managed via PublishPanel, not direct fs access by members.
 */
const PRIVILEGED_DIRS = [
  path.join(WORKSPACE_ROOT, 'uploads'),
  path.join(WORKSPACE_ROOT, 'published'),
];

/** All directories that bypass the session-write guard for ADMIN/OPERATOR. */
const SHARED_WRITE_DIRS_PRIVILEGED = [
  path.join(WORKSPACE_ROOT, 'published'),
  path.join(WORKSPACE_ROOT, 'decisions'),
  path.join(WORKSPACE_ROOT, 'docs'),
  path.join(WORKSPACE_ROOT, 'uploads'),
];

// Members get one project-scoped shared-write exception: workspace/projects/shared.
// This is the official project-to-project dropbox (2026-06-09). A member must
// still have project_members access to shared; the accessible-paths guard enforces
// that separately. Members can also write shared knowledge under docs/decisions;
// viewer/guest remain read-only there. isPathWritableByRole enforces the same
// policy at the API layer.
const MEMBER_SHARED_PROJECT_WRITE_DIRS = [
  path.join(WORKSPACE_ROOT, 'projects', 'shared'),
];

/**
 * Dotfile / system-dir denylist (never visible to anyone via /files/*, never
 * readable via Bash for non-admin). These hold credentials, audit logs, or
 * worktree state — exposing them is a privilege-escalation vector.
 *
 * Admin can still touch them via direct ssh — this is the API-level guard.
 */
const DOTFILE_DENY_PATTERNS: RegExp[] = [
  /(^|\/)\.audit(\/|$)/,
  /(^|\/)\.claude(\/|$)/,
  /(^|\/)\.mcp\.json$/,
  /(^|\/)\.temp-uploads(\/|$)/,
  /(^|\/)\.worktrees(\/|$)/,
  /(^|\/)\.git(\/|$)/,
];

/**
 * Returns true if the path matches a dotfile/system-dir we never expose via
 * the file APIs. Admin-bypass is decided by callers (most should NOT bypass —
 * the audit log itself should be unreadable through the file browser).
 */
export function isDotfileDenied(filePath: string): boolean {
  const normalized = path.resolve(filePath);
  return DOTFILE_DENY_PATTERNS.some(re => re.test(normalized));
}

/** Return true when candidate is inside root using exact path-segment boundaries. */
function isInsidePath(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + path.sep);
}

/**
 * Resolve a path for access-boundary decisions, following symlinks when the
 * target or its nearest existing ancestor exists. This closes the common escape
 * where `project/link -> ../other-project` passes a lexical prefix check.
 *
 * For not-yet-created write targets we resolve the nearest existing ancestor and
 * append the missing tail. If the path tree is synthetic/nonexistent (as in some
 * unit tests or dry-run guards), we fall back to the lexical absolute path so the
 * caller can still apply ordinary prefix policy.
 */
export function resolvePathForAccessBoundary(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return realpathSync.native(resolved);
  } catch {
    // Fall through to nearest-existing-ancestor resolution.
  }

  const missingTail: string[] = [];
  let current = resolved;
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    missingTail.unshift(path.basename(current));
    current = parent;
    if (!existsSync(current)) continue;
    try {
      return path.resolve(realpathSync.native(current), ...missingTail);
    } catch {
      return resolved;
    }
  }
}

function resolveRootForAccessBoundary(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isDeniedByDotfilePolicy(filePath: string): boolean {
  const lexical = path.resolve(filePath);
  const boundary = resolvePathForAccessBoundary(lexical);
  return isDotfileDenied(lexical) || isDotfileDenied(boundary);
}

// ─── Cache: per-user accessible paths (TTL-based) ────────────────────────────
// Avoids N+1 DB queries on every file read/write API call.
// Cache key = userId, value = { paths, expiresAt }.
// TTL = 30s — short enough that membership changes reflect quickly,
// long enough to batch rapid file operations.

const PATH_CACHE_TTL = 30_000; // 30 seconds
const pathCache = new Map<number, { paths: string[] | null; expiresAt: number }>();

function getCachedPaths(userId: number): string[] | null | undefined {
  const entry = pathCache.get(userId);
  if (!entry || Date.now() > entry.expiresAt) {
    pathCache.delete(userId);
    return undefined; // miss
  }
  return entry.paths;
}

function setCachedPaths(userId: number, paths: string[] | null): void {
  pathCache.set(userId, { paths, expiresAt: Date.now() + PATH_CACHE_TTL });
}

/** Call when membership changes (add/remove member) to invalidate immediately */
export function invalidatePathCache(userId?: number): void {
  if (userId !== undefined) {
    pathCache.delete(userId);
  } else {
    pathCache.clear(); // full flush
  }
}

// ─── API-level access checks ─────────────────────────────────────────────────

/**
 * Check if a user can access a session (via its project_id).
 * Returns { allowed: true } or { allowed: false, status, message }.
 */
export async function canAccessSession(
  sessionId: string,
  userId: number,
  role: string,
): Promise<{ allowed: true } | { allowed: false; status: number; message: string }> {
  // 2026-05-04: admin/operator 모두 통과 (decisions/2026-05-04-five-role-model.md)
  if (isPrivilegedRole(role)) return { allowed: true };

  const row = await queryOne<{ project_id: string | null; user_id: number | null; visibility: string | null; label: string | null; room_id: string | null }>(
    'SELECT project_id, user_id, visibility, label, room_id FROM sessions WHERE id = $1',
    [sessionId],
  );
  if (!row) return { allowed: false, status: 404, message: 'Session not found' };

  // Session owner can always access.
  if (row.user_id === userId) return { allowed: true };

  // Channel-bound Agent sessions are shared only with current channel members.
  // Their Agent Project is an execution identity, not an audience grant.
  if (row.room_id && (row.label === 'channel_agent' || row.label === 'channel_ai')) {
    const membership = await queryOne<{ ok: number }>(
      'SELECT 1 AS ok FROM room_members WHERE room_id = $1 AND user_id = $2',
      [row.room_id, userId],
    );
    if (membership) return { allowed: true };
    return { allowed: false, status: 403, message: 'Access denied: not a channel member' };
  }

  // Check internal share access.
  if (await hasInternalShareAccess(sessionId, userId)) return { allowed: true };

  // No project → only owner, admin, or internal share. The sole legacy exception
  // is project-less channel AI, which is intentionally shared by the room flow.
  if (!row.project_id) {
    if (row.user_id === null && row.label === 'channel_ai') return { allowed: true };
    return { allowed: false, status: 403, message: 'Access denied: session has no project' };
  }

  // Project-scoped system sessions are visible to project members.
  if (row.user_id === null) {
    if (await isProjectMember(row.project_id, userId)) return { allowed: true };
    return { allowed: false, status: 403, message: 'Access denied: not a project member' };
  }

  // Private user-owned sessions are not readable by other project members. This
  // keeps message access aligned with sidebar/list metadata privacy.
  if (row.visibility !== 'project') {
    return { allowed: false, status: 403, message: 'Access denied: private session' };
  }

  // Shared project session: project membership grants read access.
  if (await isProjectMember(row.project_id, userId)) return { allowed: true };

  return { allowed: false, status: 403, message: 'Access denied: not a project member' };
}

/**
 * Check if a user can DELETE a session.
 * Allowed: admin, session owner, or project owner.
 * Project members can view but NOT delete other users' sessions.
 */
export async function canDeleteSession(
  sessionId: string,
  userId: number,
  role: string,
): Promise<{ allowed: true } | { allowed: false; status: number; message: string }> {
  // Channel AI sessions belong to a room, not to the session sidebar. Deleting
  // one orphans the channel's AI thread (the room then auto-creates a fresh
  // empty session and the conversation appears to vanish). Block deletion for
  // EVERYONE — including admins — and steer users to "@ai /reset" inside the
  // channel when they really want to start over.
  // 결정: workspace/decisions/2026-05-23-channel-ai-session-isolation.md
  const labelRow = await queryOne<{ label: string | null }>(
    'SELECT label FROM sessions WHERE id = $1',
    [sessionId],
  );
  if (labelRow?.label === 'channel_ai' || labelRow?.label === 'channel_agent') {
    return {
      allowed: false,
      status: 409,
      message: '이 세션은 채널의 Agent 대화입니다. 사이드바에서 삭제할 수 없습니다. 채널 안에서 대화를 관리하세요.',
    };
  }

  // 2026-05-04: admin/operator 모두 통과 (decisions/2026-05-04-five-role-model.md)
  if (isPrivilegedRole(role)) return { allowed: true };

  const row = await queryOne<{ user_id: number; project_id: string | null }>(
    'SELECT user_id, project_id FROM sessions WHERE id = $1',
    [sessionId],
  );
  if (!row) return { allowed: false, status: 404, message: 'Session not found' };

  if (row.user_id === userId) return { allowed: true };

  // Project owners can delete any session within their project
  if (row.project_id) {
    const membership = await queryOne<{ role: string }>(
      'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
      [row.project_id, userId],
    );
    if (membership?.role === 'owner') return { allowed: true };
  }

  return { allowed: false, status: 403, message: 'Access denied: only the session owner can delete' };
}

/**
 * Check if a user can access a people-centered channel.
 * Project resource links never grant channel access; membership is authoritative.
 */
export async function canAccessRoom(
  roomId: string,
  userId: number,
  role: string,
): Promise<{ allowed: true } | { allowed: false; status: number; message: string }> {
  if (isPrivilegedRole(role)) return { allowed: true };

  const row = await queryOne<{ exists: boolean; is_member: boolean }>(
    `SELECT TRUE AS exists,
            EXISTS (
              SELECT 1 FROM room_members rm
               WHERE rm.room_id = cr.id AND rm.user_id = $2
            ) AS is_member
       FROM chat_rooms cr
      WHERE cr.id = $1`,
    [roomId, userId],
  );
  if (!row) return { allowed: false, status: 404, message: 'Room not found' };
  if (row.is_member) return { allowed: true };

  return { allowed: false, status: 403, message: 'Access denied: not a channel member' };
}

/**
 * Check if a user can create a session in a project.
 */
export async function canCreateInProject(
  projectId: string | null | undefined,
  userId: number,
  role: string,
): Promise<{ allowed: true } | { allowed: false; status: number; message: string }> {
  // 2026-05-04: admin/operator 모두 통과 (decisions/2026-05-04-five-role-model.md)
  if (isPrivilegedRole(role)) return { allowed: true };
  if (!projectId) return { allowed: true }; // no project = personal (allowed for now)

  if (await isProjectMember(projectId, userId)) return { allowed: true };

  return { allowed: false, status: 403, message: 'Access denied: not a project member' };
}

/**
 * Check if a user can access a task (owner, or project member).
 */
export async function canAccessTask(
  taskId: string,
  userId: number,
  role: string,
): Promise<{ allowed: true } | { allowed: false; status: number; message: string }> {
  // 2026-05-04: admin/operator 모두 통과 (decisions/2026-05-04-five-role-model.md)
  if (isPrivilegedRole(role)) return { allowed: true };

  const row = await queryOne<{ user_id: number | null; project_id: string | null }>(
    'SELECT user_id, project_id FROM tasks WHERE id = $1',
    [taskId],
  );
  if (!row) return { allowed: false, status: 404, message: 'Task not found' };

  // Owner always has access
  if (row.user_id === userId) return { allowed: true };

  // Project member can access project tasks
  if (row.project_id && await isProjectMember(row.project_id, userId)) return { allowed: true };

  return { allowed: false, status: 403, message: 'Access denied' };
}

/**
 * Check if a user can access a schedule (owner, or project member, or admin/operator).
 * Mirrors canAccessTask for the unified-scheduler 'schedules' table.
 */
export async function canAccessSchedule(
  scheduleId: string,
  userId: number,
  role: string,
): Promise<{ allowed: true } | { allowed: false; status: number; message: string }> {
  if (isPrivilegedRole(role)) return { allowed: true };

  const row = await queryOne<{ user_id: number | null; project_id: string | null }>(
    'SELECT user_id, project_id FROM schedules WHERE id = $1',
    [scheduleId],
  );
  if (!row) return { allowed: false, status: 404, message: 'Schedule not found' };

  if (row.user_id === userId) return { allowed: true };

  if (row.project_id && await isProjectMember(row.project_id, userId)) return { allowed: true };

  return { allowed: false, status: 403, message: 'Access denied' };
}

// ─── AI folder access (canUseTool path enforcement) ──────────────────────────

/**
 * Get all directory paths a user is allowed to access (for AI tool enforcement).
 * Returns null for admin/operator (= unrestricted, see workspace 루트).
 *
 * For member/viewer/guest the returned list is:
 *   - own project root_paths
 *   - READ_PUBLIC_DIRS (docs, decisions) — member write allowed; viewer/guest read-only
 *
 * Note: PRIVILEGED_DIRS (uploads, published) are NOT included — those are
 * admin/operator only. Members work with attachments under their own project.
 */
export async function getUserAccessiblePaths(
  userId: number,
  role: string,
): Promise<string[] | null> {
  if (isPrivilegedRole(role)) return null; // unrestricted (admin + operator)

  // Check cache first
  const cached = getCachedPaths(userId);
  if (cached !== undefined) return cached;

  // Cache miss — query DB
  const projectIds = await getAccessibleProjectIds(userId, role);
  if (projectIds === null) {
    setCachedPaths(userId, null);
    return null; // admin path (defensive — getAccessibleProjectIds may return null for elevated)
  }

  // Single query instead of N getProject() calls
  const { query: pgQuery } = await import('../../db/pg-repo.js');
  const rows = await pgQuery<{ root_path: string }>(
    `SELECT root_path FROM projects WHERE id = ANY($1) AND root_path IS NOT NULL`,
    [projectIds],
  );
  const projectPaths = rows.map(r => path.resolve(r.root_path));
  const result = [...projectPaths, ...READ_PUBLIC_DIRS.map(d => path.resolve(d))];

  setCachedPaths(userId, result);
  return result;
}

/**
 * Build a canUseTool-compatible path enforcement function
 * that restricts file access to user's accessible project folders.
 *
 * Unlike buildPathEnforcement (single root), this supports multiple allowed roots.
 */
function extractAbsolutePathsFromBashCommand(command: string): string[] {
  const matches = command.match(
    /(?:^|\s)(\/(?!\/|dev\/null|dev\/stderr|dev\/stdout|tmp\/|usr\/bin\/|bin\/|proc\/|sys\/)[^\s;&|>"']+)/g,
  );
  if (!matches) return [];
  return matches
    .map(p => p.trim())
    // Slash commands such as `/self-host deploy demo-server` or `/commit-session`
    // are not filesystem paths. Treat single-segment /name tokens as commands,
    // while still enforcing real paths like /etc/passwd or /home/.../file.
    .filter(p => !/^\/[A-Za-z][A-Za-z0-9_-]*$/.test(p));
}

export function buildProjectPathEnforcement(
  allowedPaths: string[],
  opts?: { readOnlyDirs?: string[] },
): (toolName: string, input: Record<string, unknown>) => DamageCheckResult {
  const roots = allowedPaths.map(resolveRootForAccessBoundary);
  const readOnlyRoots = (opts?.readOnlyDirs ?? []).map(resolveRootForAccessBoundary);

  return (toolName: string, input: Record<string, unknown>): DamageCheckResult => {
    const paths: string[] = [];

    // File tools: resolve relative paths against process cwd so they cannot
    // bypass channel roots merely by omitting an absolute prefix.
    for (const key of ['file_path', 'path', 'notebook_path']) {
      if (typeof input[key] === 'string') {
        const rawPath = input[key] as string;
        paths.push(path.isAbsolute(rawPath) ? rawPath : path.resolve(rawPath));
      }
    }
    if (Array.isArray(input.files)) {
      paths.push(...input.files
        .filter((p): p is string => typeof p === 'string')
        .map((p) => path.isAbsolute(p) ? p : path.resolve(p)));
    }

    // Bash: extract absolute filesystem paths. Slash-command tokens such as
    // `/fleet` are intentionally ignored by extractAbsolutePathsFromBashCommand.
    if (toolName === 'Bash' && typeof input.command === 'string') {
      paths.push(...extractAbsolutePathsFromBashCommand(input.command as string));
    }

    // Decide whether THIS tool call is a write attempt (used for read-only dir guard).
    const isWriteAttempt =
      WRITE_TOOLS.has(toolName) ||
      (toolName === 'Bash' &&
        typeof input.command === 'string' &&
        (BASH_MUTATOR_RE.test(input.command as string) || BASH_REDIRECT_RE.test(input.command as string)));

    for (const p of paths) {
      const resolved = path.resolve(p);
      const boundaryResolved = resolvePathForAccessBoundary(resolved);

      // Read-only dirs: present in `roots` (so reads pass) but writes blocked.
      // Used to make docs/decisions read-only for viewer/guest AI sessions
      // even though the user can READ those folders. Check both lexical and
      // realpath targets so project-local symlinks cannot write into a read-only
      // public folder.
      if (isWriteAttempt && readOnlyRoots.length > 0) {
        const isUnderReadOnly = readOnlyRoots.some(
          root => isInsidePath(root, resolved) || isInsidePath(root, boundaryResolved),
        );
        if (isUnderReadOnly) {
          console.warn(`[Project ACL] Read-only write denied: "${p}" (tool: ${toolName})`);
          return {
            allowed: false,
            message:
              `[Access Control] "${p}" is in a read-only public folder ` +
              `(workspace/docs/ or workspace/decisions/). Members can write here, ` +
              `but viewer/guest roles are read-only. Ask a member/operator/admin to update it.`, 
          };
        }
      }

      const isAllowed = roots.some(root => isInsidePath(root, boundaryResolved));
      if (!isAllowed) {
        console.warn(`[Project ACL] Denied: "${p}" not in user's accessible paths (tool: ${toolName}); realpath=${boundaryResolved}`);
        return {
          allowed: false,
          message: `[Access Control] "${p}" is outside your accessible project folders. Ask your admin for access.`,
        };
      }
    }

    return { allowed: true };
  };
}

function compileGrantPattern(pattern: string): RegExp {
  const normalized = pattern.replace(/^\/+/, '');
  const escaped = normalized
    .split('**').map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

function relativePathMatchesGrant(rel: string, allowedPaths: string[]): boolean {
  const normalized = rel.split(path.sep).join('/').replace(/^\/+/, '');
  return allowedPaths.some((pattern) => compileGrantPattern(pattern).test(normalized));
}

function buildMaintenanceGrantEnforcement(
  grant: CrossProjectMaintenanceToolGrant,
): (toolName: string, input: Record<string, unknown>) => DamageCheckResult {
  const projectRoots = grant.projectRoots.map(p => path.resolve(p));
  const allowedPaths = grant.allowedPaths.length > 0 ? grant.allowedPaths : ['AGENTS.md', '.project/**', '.tower/skills/**', 'skills/**'];

  return (toolName: string, input: Record<string, unknown>): DamageCheckResult => {
    const isWriteAttempt =
      WRITE_TOOLS.has(toolName) ||
      (toolName === 'Bash' &&
        typeof input.command === 'string' &&
        (BASH_MUTATOR_RE.test(input.command as string) || BASH_REDIRECT_RE.test(input.command as string)));

    const paths: string[] = [];
    for (const key of ['file_path', 'path', 'notebook_path']) {
      if (typeof input[key] === 'string') paths.push(input[key] as string);
    }
    if (Array.isArray(input.files)) paths.push(...input.files.filter((p): p is string => typeof p === 'string'));
    if (toolName === 'Bash' && typeof input.command === 'string') {
      const absPaths = (input.command as string).match(
        /(?:^|\s)(\/(?!dev\/null|dev\/stderr|dev\/stdout|tmp\/|usr\/bin\/|bin\/|proc\/|sys\/)[^\s;&|>"']+)/g,
      );
      if (absPaths) paths.push(...absPaths.map(p => p.trim()));
    }

    if (paths.length === 0) return { allowed: true };
    if (isWriteAttempt && grant.mode !== 'apply') {
      return {
        allowed: false,
        message: `[Maintenance Grant] Grant ${grant.id} is dry_run only. Review the diff, then create an apply grant before writing.`,
      };
    }

    for (const p of paths) {
      const resolved = path.resolve(p);
      const root = projectRoots.find(r => resolved === r || resolved.startsWith(r + path.sep));
      if (!root) {
        return { allowed: false, message: `[Maintenance Grant] "${p}" is outside granted project roots.` };
      }
      const rel = path.relative(root, resolved);
      if (!rel || !relativePathMatchesGrant(rel, allowedPaths)) {
        return {
          allowed: false,
          message: `[Maintenance Grant] "${p}" is outside granted scaffold paths (${allowedPaths.join(', ')}).`,
        };
      }
    }
    return { allowed: true };
  };
}

// ─── Session-scoped write guard (役割 무관) ──────────────────────────────────
//
// The accessible-paths guard above restricts by USER (all projects the user is a
// member of). This guard restricts by SESSION (the project this session is bound
// to). Without it, a session rooted in project A can still write into project B
// just because the user is a member of both — or, worse, create a brand-new
// `workspace/projects/<invented-name>/` folder that's not registered in the DB
// and becomes invisible to every project UI.
//
// Applies to admin as well — session boundaries are an orthogonal axis to roles.
// Writes under `workspace/projects/` MUST stay inside the session's project root.
// Writes into SHARED_WRITE_DIRS (`published/`, `decisions/`, `docs/`, `uploads/`)
// remain allowed as the sanctioned cross-project output destinations.
// Writes anywhere outside `workspace/projects/` are delegated to the existing
// accessible-paths guard below (which handles e.g. `~/tower/` vs `workspace/`).

/**
 * Resolve a cwd to its enclosing project root under `workspace/projects/<slug>/`.
 * Returns null if cwd is not under workspace/projects/ (non-project session, etc).
 * Never escapes the slug boundary — e.g. cwd=`projects/demo-org/strategy/` → `projects/demo-org/`.
 */
export function resolveSessionProjectRoot(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const resolved = path.resolve(cwd);
  const projectsDir = path.resolve(WORKSPACE_ROOT, 'projects');
  if (!resolved.startsWith(projectsDir + path.sep)) return null;
  const rel = path.relative(projectsDir, resolved);
  const slug = rel.split(path.sep)[0];
  if (!slug || slug === '..' || slug === '.') return null;
  return path.join(projectsDir, slug);
}

/** Tools that can mutate the filesystem (direct write path). */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);

/** Bash subcommands that mutate the filesystem — used for shallow detection. */
const BASH_MUTATOR_RE = /\b(mkdir|touch|mv|cp|rm|tee|ln|install|rsync|chmod|chown|tar|unzip|7z|zip|gunzip)\b/;
const BASH_REDIRECT_RE = /(?:^|[^0-9&])(>>?|\|\s*tee\b)/;

/**
 * Build a guard that blocks writes outside the current session's project root.
 * Role-independent: admin is NOT exempt. Sessions ARE their project boundary.
 *
 * Allowed write destinations:
 *   1. Anywhere under `sessionProjectRoot/`
 *   2. SHARED_WRITE_DIRS (published/decisions/docs/uploads)
 *   3. Outside `workspace/projects/` entirely — delegated to accessible-paths guard
 *
 * Denied:
 *   - `workspace/projects/<other>/...` (different project)
 *   - `workspace/projects/<new-invented-name>/...` (never-registered folder)
 */
export function buildSessionWriteGuard(
  sessionProjectRoot: string,
): (toolName: string, input: Record<string, unknown>) => DamageCheckResult {
  const projectRoot = path.resolve(sessionProjectRoot);
  const projectsDir = path.resolve(WORKSPACE_ROOT, 'projects');
  // Use the privileged set plus the official shared project dropbox.
  // buildProjectPathEnforcement (with readOnlyDirs) separately blocks members
  // from writing to docs/decisions and ensures they are actual members of
  // workspace/projects/shared before this exception can succeed.
  const sharedRoots = [
    ...SHARED_WRITE_DIRS_PRIVILEGED,
    ...MEMBER_SHARED_PROJECT_WRITE_DIRS,
  ].map(d => path.resolve(d));

  const isWriteToolPath = (resolved: string): boolean => {
    // If the target is NOT under workspace/projects/, this guard is silent —
    // the accessible-paths guard decides. (We don't want to double-restrict
    // legitimate shared writes or workspace root files.)
    if (resolved !== projectsDir && !resolved.startsWith(projectsDir + path.sep)) {
      return true;
    }
    // Under projects/ → must be inside the session's own project root.
    if (resolved === projectRoot || resolved.startsWith(projectRoot + path.sep)) {
      return true;
    }
    // Shared-write exceptions (belt & suspenders — shared dirs are not under projects/,
    // so this branch is unreachable in practice, but keeps the rule explicit).
    if (sharedRoots.some(r => resolved === r || resolved.startsWith(r + path.sep))) {
      return true;
    }
    return false;
  };

  return (toolName: string, input: Record<string, unknown>): DamageCheckResult => {
    const isWriteTool = WRITE_TOOLS.has(toolName);
    const isBash = toolName === 'Bash';
    if (!isWriteTool && !isBash) return { allowed: true };

    const paths: string[] = [];

    if (isWriteTool) {
      for (const key of ['file_path', 'path', 'notebook_path']) {
        if (typeof input[key] === 'string') paths.push(input[key] as string);
      }
      // MultiEdit may pass edits with file_path; also handle top-level file_path above.
      if (Array.isArray(input.files)) {
        paths.push(...input.files.filter((p): p is string => typeof p === 'string'));
      }
    }

    if (isBash && typeof input.command === 'string') {
      const cmd = input.command as string;
      const looksMutating = BASH_MUTATOR_RE.test(cmd) || BASH_REDIRECT_RE.test(cmd);
      if (looksMutating) {
        // Extract plausible absolute filesystem paths from the command (same
        // heuristic as buildProjectPathEnforcement), ignoring slash commands
        // such as `/fleet`.
        paths.push(...extractAbsolutePathsFromBashCommand(cmd));
      }
    }

    for (const p of paths) {
      const resolved = path.resolve(p);
      if (!isWriteToolPath(resolved)) {
        const slug = path.basename(projectRoot);
        console.warn(
          `[Session Write Guard] Denied: "${p}" — session is scoped to ${projectRoot} (tool: ${toolName})`,
        );
        return {
          allowed: false,
          message:
            `[Session Boundary] Cannot write "${p}". This session is scoped to project "${slug}" ` +
            `(${projectRoot}). Writes to other project folders — or creating a brand-new ` +
            `workspace/projects/<name>/ folder — are not allowed from within this session. ` +
            `If you need a new project, ask the user to create it from the UI. ` +
            `If you need to edit another project, open a session there. ` +
            `Project-to-project handoff files can go under workspace/projects/shared/. ` +
            `Other shared outputs can go under workspace/{published,decisions,docs,uploads}/.`,
        };
      }
    }

    return { allowed: true };
  };
}

// ─── ToolGuard: unified engine-agnostic tool gate ─────────────────────────────
// Combines: damage control + legacy path enforcement + project path enforcement.
// Each engine connects this differently:
//   Claude → canUseTool callback
//   Pi     → wrapPiTools(tools, guard)
//   Future → whatever hook the engine exposes

export type ToolGuardResult =
  | { allowed: true }
  | { allowed: false; message: string };

export interface CrossProjectMaintenanceToolGrant {
  id: string;
  mode: 'dry_run' | 'apply';
  projectRoots: string[];
  allowedPaths: string[];
}

export type ToolGuard = (toolName: string, input: Record<string, unknown>) => ToolGuardResult;

/**
 * D11 enforcement — block running a web server on the host VM from Bash.
 * Source = workspace, Execution = host (단발) OR sandbox (장기/의존성/외부 공개).
 *
 * 결정: workspace/decisions/2026-05-12-d11-rule1-removal-keep-web-server-block.md
 *      (Rule 1 폐지, Rule 2 만 유지)
 *      workspace/decisions/2026-05-02-execution-sandbox-d12-sibling-sandbox-mandatory.md
 *      (sandbox 가 *기본 호스팅 모델* — 강제는 web server 만, 나머지는 안내)
 *
 * 매칭 규칙 (현재 1개):
 *   - python -m <web-server-module> — 본체에서 web server 띄우기 시도 → 차단
 *     대상 모듈: uvicorn, gunicorn, hypercorn, daphne, waitress, flask, fastapi,
 *               http.server, SimpleHTTPServer
 *
 * 예외 (이전 Rule 1 폐지로 모두 통과):
 *   - python script.py / node app.js / bash helper.sh — 단발 compute. OS timeout 이
 *     자연 격리 (Bash tool default 120s, max 600s). 영구 루프는 자연스럽게 못 굴러감.
 *   - python -c, node -e, --help, --version
 *   - python -m <기타 모듈> (pip, unittest, json.tool, venv, ensurepip 등)
 *   - 패키지 매니저 / 인프라 명령 (npm, npx, tsc, vite, vitest, pm2, az, docker, ssh, git, gh, psql 등)
 *
 * 이력:
 * - 2026-04-28: 초기 도입 — Rule 1 (경로 기반) + 후일 Rule 2.
 * - 2026-05-06: Rule 2 추가 — demo-org `python3 -m uvicorn main:app` 사건 (https://...:8000).
 * - 2026-05-12: Rule 1 폐지 — demo-org refuse-to-edit reflex 환각 (deny 메시지 톤이
 *   Edit 까지 일반화됨). 단발 compute 본체 허용으로 단순화. Rule 2 만 유지.
 */
/**
 * Build a guard that blocks cross-project memory READS — both SDK metadata paths
 * and other Tower projects' memory directories.
 *
 * Always-on (role-independent). Even admin/operator sessions get this. The leak
 * vector — SDK exposing cwd-memory via init system message's `memory_paths.auto`,
 * combined with AI's ability to recall standard Claude Code memory path patterns
 * (`~/.claude/projects/<sanitize(cwd)>/memory/`) and infer them for sibling cwds —
 * was confirmed on 2026-05-07 to bypass project boundaries even for admin sessions.
 * The Phase 1 patch (CLAUDE_CODE_DISABLE_AUTO_MEMORY=true env in claude-sdk.ts)
 * stops auto-exposure but does not stop AI from inferring sibling-cwd memory paths
 * and reading them directly. This guard is the second line of defense.
 *
 * Path patterns blocked:
 *   1. ~/.claude (or .claude-gmail etc) projects PROJ memory  — SDK cwd-memory dirs
 *   2. ~/.claude (any) memory.db                              — FTS5 search DB
 *   3. ~/.claude (any) projects PROJ session.jsonl            — session transcripts
 *   4. workspace projects OTHER (.project)? memory  — when sessionProjectRoot
 *      is set and target is a different project's memory dir.
 *
 * Tower's normal workflows do NOT need to read any of these. Debug / forensic
 * access uses ssh directly.
 *
 * 결정: workspace/decisions/2026-05-07-isolation-hypotheses-broken.md
 */
export function buildCrossProjectReadGuard(
  sessionProjectRoot?: string,
  role?: string,
  opts?: { mgmtVmBypass?: boolean },
): (toolName: string, input: Record<string, unknown>) => ToolGuardResult {
  // mgmtVmBypass: admin/operator 가 프로젝트 간 운영 작업을 수행할 때 true.
  // Read/Glob/Grep 까지 통과시켜 sibling 프로젝트의 메모리/메타데이터를 조회하도록 함.
  // customer_manager/member/viewer 는 false 라 그대로 차단.
  // 결정: workspace/decisions/2026-06-05-admin-operator-cross-project-write-on-all-vms.md
  const mgmtVmBypass = opts?.mgmtVmBypass === true;
  // SDK metadata path — always blocked.
  // Matches: .claude/projects/<X>/memory/..., .claude-gmail/projects/...,
  //          .claude/projects/<X>/<Y>.jsonl, .claude/memory.db, .claude-gmail/memory.db
  const SDK_LEAK_RE = /\.claude(?:-[a-z]+)?\/(?:projects\/[^/\s]+\/(?:memory(?:\/|$)|[\w-]+\.jsonl)|memory\.db)/;

  // Cross-project memory dir — only blocked when this session is bound to a project.
  const otherProjMemoryRe = /workspace\/projects\/([^/\s]+)\/(?:\.project\/)?memory(?:\/|$)/;
  const currentProjectName = sessionProjectRoot ? path.basename(sessionProjectRoot) : null;

  const denyMessage = (target: string, reason: string): ToolGuardResult => ({
    allowed: false,
    message: [
      `Cross-project memory read denied — ${reason}.`,
      `Target: ${target.slice(0, 200)}${target.length > 200 ? '…' : ''}`,
      ``,
      `이 path 는 다른 프로젝트의 컨텍스트 (사용자 페르소나, 고객 정보, 메모리) 를 담고 있어 멀티 테넌트 격리 정책에 따라 read 차단됩니다.`,
      `결정: workspace/decisions/2026-05-07-isolation-hypotheses-broken.md`,
    ].join('\n'),
  });

  // admin/operator 의 Bash 는 정리·forensic 작업을 위해 SDK metadata path 통과 (log + allow).
  // AI 자발적 read 누수의 압도적 다수는 Read/Glob/Grep tool 로 일어나며, Bash 는 admin 이
  // 의도적으로 호출하는 경우가 대부분. 의도 구분 없이 차단하면 자기 정리 못 하는 부작용.
  // member/viewer 는 모든 tool 에서 차단 (admin override 없음).
  const adminBypass = isPrivilegedRole(role);

  return (toolName: string, input: Record<string, unknown>): ToolGuardResult => {
    // path-like 필드 모두 검사 — Read.file_path, Glob.path/pattern, Grep.path/pattern,
    // Bash.command, NotebookRead 등. substring 매칭이라 quoted/redirected path 도 catch.
    const candidates: string[] = [];
    if (typeof input.file_path === 'string') candidates.push(input.file_path);
    if (typeof input.path === 'string') candidates.push(input.path);
    if (typeof input.pattern === 'string') candidates.push(input.pattern);
    if (typeof input.command === 'string') candidates.push(input.command);
    if (typeof input.notebook_path === 'string') candidates.push(input.notebook_path);

    for (const target of candidates) {
      if (SDK_LEAK_RE.test(target)) {
        if (mgmtVmBypass) {
          // log + allow — admin/operator cross-project operations (Read/Glob/Grep 포함).
          // eslint-disable-next-line no-console
          console.warn(`[cross-proj-read] mgmtVmBypass (${toolName}): ${target.slice(0, 200)}`);
          continue;
        }
        if (toolName === 'Bash' && adminBypass) {
          // log + allow — admin Bash bypass for management / forensic ops.
          // eslint-disable-next-line no-console
          console.warn(`[cross-proj-read] admin Bash bypass: ${target.slice(0, 200)}`);
          continue;
        }
        return denyMessage(target, 'SDK cwd-memory / metadata path');
      }
      if (currentProjectName) {
        const m = target.match(otherProjMemoryRe);
        if (m && m[1] !== currentProjectName) {
          if (mgmtVmBypass) {
            // eslint-disable-next-line no-console
            console.warn(`[cross-proj-read] mgmtVmBypass (${toolName}, other project memory): ${target.slice(0, 200)}`);
            continue;
          }
          if (toolName === 'Bash' && adminBypass) {
            // eslint-disable-next-line no-console
            console.warn(`[cross-proj-read] admin Bash bypass (other project memory): ${target.slice(0, 200)}`);
            continue;
          }
          return denyMessage(
            target,
            `target project '${m[1]}' ≠ current '${currentProjectName}'`,
          );
        }
      }
    }

    return { allowed: true };
  };
}

function buildSandboxExecutionGuard(): (toolName: string, input: Record<string, unknown>) => ToolGuardResult {
  // python -m <web-server-module> — 본체 위 web server 차단
  // 모듈 이름은 단어 경계 또는 dot 까지 매칭 (예: http.server, fastapi.cli)
  const moduleWebServerRe = /\b(python3?)\s+-m\s+(uvicorn|gunicorn|hypercorn|daphne|waitress|flask|fastapi|http\.server|SimpleHTTPServer)\b/;

  const denyMessage = (label: string, hint: string): ToolGuardResult => ({
    allowed: false,
    message: [
      `Running a web server on the host VM is blocked (D11).`,
      `Command: ${label}`,
      ``,
      `이 가드는 본체 위에 *web server* 를 띄우는 명령만 막습니다. 다른 동작은 정상:`,
      `  • Read / Edit / Glob / Grep — 워크스페이스 파일 보기·수정 OK.`,
      `  • 단발 Bash (\`python script.py\`, \`node analyze.mjs\`, \`bash helper.sh\`) — 본체 OK.`,
      `  • 패키지 매니저 / 인프라 (npm, docker, pm2, ...) — 본체 OK.`,
      ``,
      `web server 가 필요하면 sandbox 의 \`python-web\` runtime 으로:`,
      `  mcp__sandbox__run({`,
      `    runtime: 'python-web',  // FastAPI/uvicorn 사전 설치`,
      `    workspace_path: '<folder relative to workspace/>',`,
      `    entrypoint: '${hint}'`,
      `  })`,
      ``,
      `장기 운영 (며칠 도는 API/워커) 은 sandbox.tool.start (D12 Phase 2). ACA 는 *예외*`,
      `(GPU·거대 스케일·외부 SLA) — 단순 "외부 공개" 만으로 ACA 가지 말 것.`,
      ``,
      `결정: workspace/decisions/2026-05-12-d11-rule1-removal-keep-web-server-block.md`,
      `      workspace/decisions/2026-05-02-execution-sandbox-d12-sibling-sandbox-mandatory.md`,
    ].join('\n'),
  });

  return (toolName: string, input: Record<string, unknown>): ToolGuardResult => {
    if (toolName !== 'Bash') return { allowed: true };
    const cmd = String(input.command ?? '');
    if (!cmd) return { allowed: true };

    // python -m <web-server-module> — workspace 경로 무관, 본체 web server 차단
    const mod = cmd.match(moduleWebServerRe);
    if (mod) {
      return denyMessage(mod[0], `${mod[1]} -m ${mod[2]} ...`);
    }

    return { allowed: true };
  };
}

/**
 * Build a unified tool guard that combines all access checks.
 * Call once per session/task, reuse for every tool call.
 */
export function buildToolGuard(opts: {
  role: string;
  allowedPath?: string;
  accessiblePaths?: string[] | null;
  /** Channel-linked roots that every audience member can read but not write. */
  readOnlyPaths?: string[];
  /** Channel runs deny path-implicit Bash commands because cwd itself is not authority. */
  denyImplicitBash?: boolean;
  /** Restrict shared-channel execution to audience-scoped file tools and public web reads. */
  channelSafeToolsOnly?: boolean;
  /**
   * The project root this session is bound to (resolved from cwd).
   * Kept for cross-project memory read protection and legacy callers. Since
   * 2026-06-13 normal file writes are governed by user-level project ACL,
   * not by the current session project.
   */
  sessionProjectRoot?: string;
  maintenanceGrant?: CrossProjectMaintenanceToolGrant | null;
}): ToolGuard {
  const damageCheck = buildDamageControl(opts.role);
  const secretCheck = buildSecretGuard(opts.role);
  // Legacy coarse root containment. In real member sessions this is usually
  // workspace/projects, while the active ACL also grants shared docs/decisions.
  // Include accessiblePaths as coarse roots so the old bridge does not block
  // policy-approved shared knowledge paths before projectPathCheck can allow them.
  const coarseAllowedPaths = opts.allowedPath
    ? Array.from(new Set([opts.allowedPath, ...((Array.isArray(opts.accessiblePaths) ? opts.accessiblePaths : []))]))
    : [];
  const coarsePathCheck = coarseAllowedPaths.length > 0
    ? buildProjectPathEnforcement(coarseAllowedPaths)
    : null;
  // decisions/docs WRITE 는 member 이상 허용. viewer/guest 만 read-only.
  // 결정 변경: 2026-06-10 — members need broad working rights over shared docs.
  const readOnlyDirs = [
    ...((opts.role === 'viewer' || opts.role === 'guest') ? READ_PUBLIC_DIRS : []),
    ...(opts.readOnlyPaths ?? []),
  ];
  const projectPathCheck = Array.isArray(opts.accessiblePaths)
    ? buildProjectPathEnforcement(opts.accessiblePaths, { readOnlyDirs })
    : null;
  const grantPathCheck = opts.maintenanceGrant
    ? buildMaintenanceGrantEnforcement(opts.maintenanceGrant)
    : null;
  // 2026-06-13: ordinary file writes are governed by user-level project ACL,
  // not by the current session project. If a user can write both project A and
  // project B, AI file/bash tools may move normal artifacts between them.
  // Runtime Box(project_shell) remains project-local because it only mounts the
  // current project at /workspace. Ghost-project, secret, dotfile, and damage
  // guards remain active.
  // 결정: workspace/decisions/2026-06-13-user-accessible-cross-project-file-writes.md
  // 2026-06-23: direct Tower repo mutation is admin-only. Operators may manage
  // services and customer/project files, but code changes under ~/tower must be
  // performed by admin sessions.
  const crossProjectFree = isAdminOrOperator(opts.role);
  const isTowerRepoMutation = (toolName: string, input: Record<string, unknown>): boolean => {
    const bashCommand = toolName === 'Bash' && typeof input.command === 'string'
      ? input.command as string
      : '';
    const looksLikeRepoMutatingBash = Boolean(bashCommand) && (
      BASH_MUTATOR_RE.test(bashCommand) ||
      BASH_REDIRECT_RE.test(bashCommand) ||
      /\bgit\b[\s\S]{0,120}\b(add|apply|checkout|switch|restore|reset|merge|rebase|cherry-pick|revert|commit|rm|mv|clean|pull|push|worktree|stash)\b/.test(bashCommand) ||
      /\b(npm|pnpm|yarn|bun)\b[\s\S]{0,120}\b(install|add|remove|update|build)\b/.test(bashCommand) ||
      /\bsed\b[\s\S]{0,80}\s-i\b/.test(bashCommand) ||
      /\bperl\b[\s\S]{0,80}\s-pi\b/.test(bashCommand)
    );
    const isWriteAttempt = WRITE_TOOLS.has(toolName) || looksLikeRepoMutatingBash;
    if (!isWriteAttempt) return false;

    const paths: string[] = [];
    for (const key of ['file_path', 'path', 'notebook_path']) {
      if (typeof input[key] === 'string') paths.push(input[key] as string);
    }
    if (Array.isArray(input.files)) paths.push(...input.files.filter((p): p is string => typeof p === 'string'));
    if (toolName === 'Bash' && typeof input.command === 'string') {
      const absPaths = (input.command as string).match(
        /(?:^|\s)(\/(?!dev\/null|dev\/stderr|dev\/stdout|tmp\/|usr\/bin\/|bin\/|proc\/|sys\/)[^\s;&|>"']+)/g,
      );
      if (absPaths) paths.push(...absPaths.map(p => p.trim()));
    }

    return paths.some((p) => {
      const resolved = path.resolve(p);
      return resolved === TOWER_REPO_ROOT || resolved.startsWith(TOWER_REPO_ROOT + path.sep);
    });
  };
  const crossProjReadCheck = buildCrossProjectReadGuard(
    opts.sessionProjectRoot,
    opts.role,
    { mgmtVmBypass: crossProjectFree },
  );
  const ghostProjectCheck = buildGhostProjectGuard({
    existingProjectRoots: Array.isArray(opts.accessiblePaths) ? opts.accessiblePaths : null,
  });
  const sandboxExecCheck = buildSandboxExecutionGuard();

  const channelSafeTools = new Set([
    'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'Find',
    'WebFetch', 'WebSearch', 'TodoWrite', 'KnowledgeSearch', 'KnowledgeRead',
  ]);

  return (toolName: string, input: Record<string, unknown>): ToolGuardResult => {
    if (opts.channelSafeToolsOnly && !channelSafeTools.has(toolName)) {
      return {
        allowed: false,
        message: `[Channel Access Control] ${toolName} is not available in shared channel runs because its data or side effects are not audience-scoped.`,
      };
    }
    if (opts.denyImplicitBash && toolName === 'Bash') {
      return {
        allowed: false,
        message: '[Channel Access Control] Bash is disabled in shared channel runs. Use scoped file/data tools on explicitly linked resources.',
      };
    }

    // 1. Damage control (role-based restrictions)
    const dc = damageCheck(toolName, input);
    if (!dc.allowed) return dc;

    // 2. Secret file protection (admin: log+allow, others: block)
    //    Runs early so secret reads are blocked before any path/ACL check
    //    might let them through. See damage-control.ts:buildSecretGuard().
    const sg = secretCheck(toolName, input);
    if (!sg.allowed) return sg;

    // 2b. Cross-project memory READ guard — blocks SDK metadata paths and
    //     other projects' memory directories. Always-on, role-independent.
    //     2026-05-07 leak audit confirmed admin sessions are NOT immune to
    //     cross-project memory reads (SDK exposes via memory_paths.auto and
    //     AI infers sibling-cwd paths from memory). Phase 1 patch
    //     (claude-sdk.ts: CLAUDE_CODE_DISABLE_AUTO_MEMORY) stops auto-exposure.
    //     This is the second line of defense against AI-inferred reads.
    //     결정: workspace/decisions/2026-05-07-isolation-hypotheses-broken.md
    const cpr = crossProjReadCheck(toolName, input);
    if (!cpr.allowed) return cpr;

    // 3. Block agent teams (CPU spike risk)
    if (toolName === 'TeamCreate') {
      return { allowed: false, message: 'Agent teams are disabled on this server.' };
    }

    // 4. D11 — block direct workspace code execution via Bash
    //    Source = workspace, Execution = sandbox VM. Use mcp__sandbox__run.
    const ec = sandboxExecCheck(toolName, input);
    if (!ec.allowed) return ec;

    // 5. Session-scoped WRITE guard is intentionally not wired by default
    //    (2026-06-13). User-level accessiblePaths now decide normal
    //    cross-project file writes; ghostProjectGuard below still blocks
    //    unregistered workspace/projects/<x>/ creation.

    // 5a. Tower repo WRITE guard — direct codebase mutation is admin-only.
    //     Operator sessions can manage services and customer/project files, but
    //     must not patch ~/tower directly from tools.
    if (opts.role !== 'admin' && isTowerRepoMutation(toolName, input)) {
      return {
        allowed: false,
        message: `[Access Control] Direct Tower repo writes under ${TOWER_REPO_ROOT} require admin. Use an admin session for code changes; operators should not modify the Tower repo directly.`,
      };
    }

    // 5b. Ghost project guard (always-on, role-independent).
    //     Blocks creation of new `workspace/projects/<X>/` folders that lack a
    //     DB row / AGENTS.md / .project/ scaffold. This is the canonical
    //     enforcement point for sessions where buildSessionWriteGuard does NOT
    //     apply (cwd outside workspace/projects/<X>/) AND admin/operator's
    //     `permissionMode: 'bypassPermissions'` causes the SDK to ignore the
    //     PreToolUse hook deny. canUseTool callbacks always run regardless of
    //     permission mode.
    //     Decision: workspace/decisions/2026-05-04-projects-mkdir-policy.md
    const gpc = ghostProjectCheck(toolName, input);
    if (!gpc.allowed) return gpc;

    // 6–7. File/path containment remains mandatory for members and for all
    // structured file tools. A privileged native Bash session is the explicit
    // host-operation surface: admin/operator may use /etc, systemd, Docker,
    // package managers, and paths outside the Project when the task requires it.
    // Damage, secret, ghost-project, confirmation, and audit guards above still run.
    const privilegedNativeBash = toolName === 'Bash' && isAdminOrOperator(opts.role);
    if (!privilegedNativeBash) {
      // Legacy per-user path enforcement (coarse containment).
      if (coarsePathCheck) {
        const pc = coarsePathCheck(toolName, input);
        if (!pc.allowed) return pc;
      }

      // Project-based path enforcement (user-level accessible paths).
      if (projectPathCheck) {
        const ppc = projectPathCheck(toolName, input);
        if (!ppc.allowed) {
          if (grantPathCheck) {
            const grantCheck = grantPathCheck(toolName, input);
            if (grantCheck.allowed) return { allowed: true };
          }
          return ppc;
        }
      }
    }

    return { allowed: true };
  };
}

/**
 * Build a guard that blocks creation of NEW `workspace/projects/<X>/` folders
 * where `<X>` does not exist on disk — these would be "ghost projects" with
 * no DB row, no AGENTS.md, no `.project/` directory, no sidebar entry, and
 * no PM context auto-injection.
 *
 * Always-on (role-independent). This is the canonical enforcement point —
 * the PreToolUse hook (`~/.claude/hooks/workspace-guard/pre-tool-use.mjs`)
 * runs the same logic, but admin/operator sessions use SDK
 * `permissionMode: 'bypassPermissions'` which makes the SDK ignore hook
 * deny responses. The `canUseTool` callback that this guard plugs into is
 * always invoked regardless of permission mode, so this is the only
 * enforcement that catches ghost-mkdir attempts in admin/operator sessions
 * whose cwd is outside `workspace/projects/<X>/` (so `buildSessionWriteGuard`
 * doesn't apply either).
 *
 * Tower projects must be created via:
 *   • Sidebar: + button next to "Projects".
 *   • CLI:     `~/workspace/scripts/tower-project-create.sh <slug>`.
 *   • API:     `POST /api/projects {"name":"<slug>"}`.
 *
 * Override: `TOWER_WORKSPACE_UNRESTRICTED=1` env var (admin escape hatch —
 * mirrors the PreToolUse hook).
 *
 * Decision: workspace/decisions/2026-05-04-projects-mkdir-policy.md
 */
export function buildGhostProjectGuard(
  opts?: { existingProjectRoots?: string[] | null },
): (toolName: string, input: Record<string, unknown>) => DamageCheckResult {
  const projectsDir = path.resolve(WORKSPACE_ROOT, 'projects');
  const knownProjectRoots = new Set((opts?.existingProjectRoots ?? []).map(p => path.resolve(p)));
  const HOME = process.env.HOME || '/home';

  const expandTilde = (p: string): string =>
    p.startsWith('~/') ? HOME + p.slice(1) : p;

  // Returns the would-be-created project slug if `resolved` falls under a
  // not-yet-existing `workspace/projects/<slug>/` path; otherwise null.
  const newProjectSlug = (resolved: string): string | null => {
    if (resolved !== projectsDir && !resolved.startsWith(projectsDir + path.sep)) {
      return null;
    }
    const rel = path.relative(projectsDir, resolved);
    if (!rel || rel === '' || rel.startsWith('..')) return null;
    const slug = rel.split(path.sep)[0];
    if (!slug || slug === '.' || slug === '..') return null;
    const slugPath = path.join(projectsDir, slug);
    // If the user-level ACL contains this project root, it came from the DB
    // project membership query and counts as an existing registered project even
    // in unit tests where the fixture directory is not present on disk.
    if (knownProjectRoots.has(path.resolve(slugPath))) return null;
    if (existsSync(slugPath)) return null; // already exists → grandfathered
    return slug;
  };

  return (toolName: string, input: Record<string, unknown>): DamageCheckResult => {
    // Admin escape hatch — same env var as PreToolUse hook.
    if (process.env.TOWER_WORKSPACE_UNRESTRICTED === '1') {
      return { allowed: true };
    }

    const isWriteTool = WRITE_TOOLS.has(toolName);
    const isBash = toolName === 'Bash';
    if (!isWriteTool && !isBash) return { allowed: true };

    const candidates: string[] = [];

    if (isWriteTool) {
      for (const key of ['file_path', 'path', 'notebook_path']) {
        const v = input[key];
        if (typeof v === 'string') candidates.push(v);
      }
      if (Array.isArray((input as { files?: unknown }).files)) {
        const files = (input as { files: unknown[] }).files;
        for (const f of files) if (typeof f === 'string') candidates.push(f);
      }
    }

    if (isBash && typeof input.command === 'string') {
      const cmd = input.command;
      const looksMutating = BASH_MUTATOR_RE.test(cmd) || BASH_REDIRECT_RE.test(cmd);
      if (looksMutating) {
        // Absolute paths. Keep this shared with the normal Bash ACL parser so
        // comments, URLs, slash commands, and host paths receive one contract.
        candidates.push(...extractAbsolutePathsFromBashCommand(cmd));
        // ~/workspace/... (tilde-prefixed)
        const tildePaths = cmd.match(/(?:^|\s)(~\/workspace\/[^\s;&|>"']+)/g);
        if (tildePaths) candidates.push(...tildePaths.map(s => s.trim()));
      }
      // Bash also covers `git clone <url> <dst>` and `git worktree add <dst>`
      // even when BASH_MUTATOR_RE doesn't match (no mkdir/cp/mv keyword).
      // Extract the destination explicitly so ghost folders via git also blocked.
      const cloneMatch = cmd.match(/\bgit\s+clone\s+(?:-[^\s]+\s+)*[^\s]+\s+([^\s;&|>"']+)/);
      if (cloneMatch && cloneMatch[1]) candidates.push(cloneMatch[1]);
      const worktreeMatch = cmd.match(/\bgit\s+worktree\s+add\s+(?:-[^\s]+\s+)*([^\s;&|>"']+)/);
      if (worktreeMatch && worktreeMatch[1]) candidates.push(worktreeMatch[1]);
    }

    for (const raw of candidates) {
      const resolved = path.resolve(expandTilde(raw));
      const slug = newProjectSlug(resolved);
      if (slug) {
        return {
          allowed: false,
          message:
            `[Ghost Project Guard] Cannot create new project folder ` +
            `"workspace/projects/${slug}/". Tower projects must be created ` +
            `via the project API/UI/CLI — otherwise the DB row, AGENTS.md ` +
            `template, .project/ directory, sidebar entry, and session ` +
            `context inheritance never get set up (it becomes a "ghost ` +
            `project").\n\n` +
            `Use one of:\n` +
            `  • Sidebar: click the "+" next to "Projects".\n` +
            `  • CLI:     ~/workspace/scripts/tower-project-create.sh ${slug}\n` +
            `  • API:     POST /api/projects {"name":"${slug}"}\n\n` +
            `If this is a temp scratch dir for an existing project, use:\n` +
            `  workspace/projects/<existing>/experiments/${slug}/\n\n` +
            `Admin override (rare): re-run with TOWER_WORKSPACE_UNRESTRICTED=1 in env.\n` +
            `Decision: workspace/decisions/2026-05-04-projects-mkdir-policy.md`,
        };
      }
    }

    return { allowed: true };
  };
}

/**
 * Wrap Pi SDK tools with a ToolGuard.
 * Pi tools have { name, parameters, execute(toolCallId, args, signal) } shape.
 * Returns new tool objects with guarded execute().
 *
 * ALL tools are wrapped — damage control (role-based whitelist) applies to every tool,
 * not just file/bash tools. Path extraction only runs for known file tools.
 */
export function wrapPiTools(tools: any[], guard: ToolGuard, opts?: { projectRoot?: string }): any[] {
  const normalizeToolName = (name: string) => {
    if (!name.includes('_')) return name.charAt(0).toUpperCase() + name.slice(1);
    return name
      .split('_')
      .filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
  };

  const mapRuntimeWorkspacePath = (value: string): string => {
    if (!opts?.projectRoot || (value !== '/workspace' && !value.startsWith('/workspace/'))) return value;
    const suffix = value.slice('/workspace'.length);
    const resolvedRoot = path.resolve(opts.projectRoot);
    const resolved = path.resolve(resolvedRoot, `.${suffix || ''}`);
    if (resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep)) return resolved;
    return value;
  };

  return tools.map(tool => {
    const toolName: string = tool.name || '';
    if (!tool.execute) return tool; // safety: skip if no execute

    const origExecute = tool.execute;
    const isBash = toolName === 'bash';

    return {
      ...tool,
      execute: async (...execArgs: any[]) => {
        // Pi tool execute signature: (toolCallId, params, signal)
        // Custom tools may also use (toolCallId, params, signal)
        const args = execArgs[1] ?? execArgs[0] ?? {};

        // Map Pi param names → guard expected format
        const input: Record<string, unknown> = {};
        if (args.path && !(typeof args.path === 'string' && args.path.startsWith('session://attachments/'))) input.file_path = mapRuntimeWorkspacePath(args.path);
        if (args.file_path) input.file_path = mapRuntimeWorkspacePath(args.file_path);
        if (args.notebook_path) input.notebook_path = mapRuntimeWorkspacePath(args.notebook_path);
        if (Array.isArray(args.files)) input.files = args.files.map((p: unknown) =>
          typeof p === 'string' && !p.startsWith('session://attachments/') ? mapRuntimeWorkspacePath(p) : p,
        );
        if (isBash && args.command) input.command = args.command;

        const guardName = normalizeToolName(toolName);
        const check = guard(guardName, input);
        if (!check.allowed) {
          return {
            content: [{ type: 'text', text: `[Access Denied] ${check.message}` }],
          };
        }

        return origExecute.call(tool, ...execArgs);
      },
    };
  });
}

// ─── File browser filtering ──────────────────────────────────────────────────

/**
 * Get the list of project folders a user can see in the file browser.
 * Returns folder paths under workspace/projects/ that the user has access to,
 * plus public areas (READ_PUBLIC_DIRS for everyone, PRIVILEGED_DIRS only for
 * admin/operator).
 */
export async function getVisibleFilePaths(
  userId: number,
  role: string,
): Promise<{ projectPaths: string[]; publicPaths: string[]; isAdmin: boolean }> {
  if (isPrivilegedRole(role)) {
    return {
      projectPaths: [], // empty = show all (admin/operator see workspace root)
      publicPaths: [...READ_PUBLIC_DIRS, ...PRIVILEGED_DIRS],
      isAdmin: true, // legacy field name — really means "privileged" (admin/operator)
    };
  }

  const accessiblePaths = await getUserAccessiblePaths(userId, role);
  return {
    projectPaths: accessiblePaths || [],
    publicPaths: READ_PUBLIC_DIRS, // members see only docs + decisions (read-only)
    isAdmin: false,
  };
}

/**
 * Check if a specific file path is accessible to a user (READ).
 * Used by file read/list/exists APIs. Write APIs additionally enforce
 * isPathWritableByRole() below.
 *
 * Policy (2026-05-02 — workspace root isolation):
 *   1. Dotfile/system-dir denylist applies to ALL roles (incl. admin)
 *   2. admin/operator → unrestricted (workspace root visible)
 *   3. member/viewer → projects they're a member of + READ_PUBLIC_DIRS
 *      (docs, decisions). PRIVILEGED_DIRS (uploads, published) blocked.
 *      Workspace root direct files (principles.md etc) blocked.
 */
export async function isPathAccessible(
  filePath: string,
  userId: number,
  role: string,
): Promise<boolean> {
  const resolved = path.resolve(filePath);
  const boundaryResolved = resolvePathForAccessBoundary(resolved);

  // 1. Dotfile/system-dir denylist — applies to everyone. Check the lexical
  // path and the symlink-resolved target.
  if (isDeniedByDotfilePolicy(resolved)) return false;

  // 2. Privileged roles see everything else
  if (isPrivilegedRole(role)) return true;

  const projectsDir = resolveRootForAccessBoundary(path.join(WORKSPACE_ROOT, 'projects'));
  const workspaceRoot = resolveRootForAccessBoundary(WORKSPACE_ROOT);

  // 3. Read-public dirs (docs, decisions) — everyone reads
  for (const pub of READ_PUBLIC_DIRS) {
    const pubResolved = resolveRootForAccessBoundary(pub);
    if (isInsidePath(pubResolved, boundaryResolved)) return true;
  }

  // 4. Privileged dirs (uploads, published) — members blocked
  for (const priv of PRIVILEGED_DIRS) {
    const privResolved = resolveRootForAccessBoundary(priv);
    if (isInsidePath(privResolved, boundaryResolved)) return false;
  }

  // 5. Workspace root direct files (e.g. AGENTS.md, principles.md, BACKLOG.md) — members blocked
  //    The root itself is operator territory now (decision 2026-05-02).
  if (boundaryResolved === workspaceRoot) return false;
  if (isInsidePath(workspaceRoot, boundaryResolved) && !isInsidePath(projectsDir, boundaryResolved)) {
    // Outside projects/, not in a public dir → only privileged.
    // External project root_paths (codebase browsing for project members) handled below.
    const accessiblePaths = await getUserAccessiblePaths(userId, role);
    if (accessiblePaths === null) return true; // privileged path (defensive)
    return accessiblePaths.some(root => isInsidePath(resolveRootForAccessBoundary(root), boundaryResolved));
  }

  // 6. Under projects/ → project membership check
  const accessiblePaths = await getUserAccessiblePaths(userId, role);
  if (accessiblePaths === null) return true; // privileged (defensive)

  return accessiblePaths.some(root => isInsidePath(resolveRootForAccessBoundary(root), boundaryResolved));
}

/**
 * Check if a path is WRITABLE by the given role.
 *
 * - Dotfiles → never (anyone)
 * - Privileged → all paths writable
 * - Member → project root_paths + READ_PUBLIC_DIRS writable.
 * - Viewer/guest → READ_PUBLIC_DIRS read-only; project writes depend on role/tool guards.
 *   PRIVILEGED_DIRS blocked.
 *
 * NOTE: This is the policy gate. The session-scope guard (buildSessionWriteGuard)
 * adds an orthogonal restriction for non-admin/operator sessions (writes must
 * stay inside the session's project). Both must pass.
 */
export async function isPathWritableByRole(
  filePath: string,
  userId: number,
  role: string,
): Promise<boolean> {
  const resolved = path.resolve(filePath);
  const boundaryResolved = resolvePathForAccessBoundary(resolved);
  if (isDeniedByDotfilePolicy(resolved)) return false;
  if (isPrivilegedRole(role)) return true;

  // Members: project roots + shared knowledge dirs. Viewer/guest: shared knowledge read-only.
  const projectsDir = resolveRootForAccessBoundary(path.join(WORKSPACE_ROOT, 'projects'));
  const workspaceRoot = resolveRootForAccessBoundary(WORKSPACE_ROOT);

  // Block writes to READ_PUBLIC_DIRS only for viewer/guest.
  if (role === 'viewer' || role === 'guest') {
    for (const pub of READ_PUBLIC_DIRS) {
      const pubResolved = resolveRootForAccessBoundary(pub);
      if (isInsidePath(pubResolved, boundaryResolved)) return false;
    }
  }
  // Block writes to PRIVILEGED_DIRS for non-privileged
  for (const priv of PRIVILEGED_DIRS) {
    const privResolved = resolveRootForAccessBoundary(priv);
    if (isInsidePath(privResolved, boundaryResolved)) return false;
  }
  // Block writes to workspace root direct files
  if (boundaryResolved === workspaceRoot) return false;
  if (isInsidePath(workspaceRoot, boundaryResolved) && !isInsidePath(projectsDir, boundaryResolved)) {
    // Outside projects/, not a public/privileged dir → check accessible roots.
    const accessiblePaths = await getUserAccessiblePaths(userId, role);
    if (accessiblePaths === null) return true;
    return accessiblePaths.some(root => isInsidePath(resolveRootForAccessBoundary(root), boundaryResolved));
  }

  // Inside projects/ → project membership
  const accessiblePaths = await getUserAccessiblePaths(userId, role);
  if (accessiblePaths === null) return true;
  return accessiblePaths.some(root => isInsidePath(resolveRootForAccessBoundary(root), boundaryResolved));
}

// ─── Auto-mapping: cwd → project_id ──────────────────────────────────────────

/**
 * Find the project whose root_path matches (or contains) a given cwd.
 * Used to auto-assign project_id when creating sessions without explicit projectId.
 * Returns project id or null if no match.
 */
export async function findProjectByPath(cwd: string): Promise<string | null> {
  const resolved = path.resolve(cwd);
  const { query: pgQuery } = await import('../../db/pg-repo.js');
  const rows = await pgQuery<{ id: string; root_path: string }>(
    `SELECT id, root_path FROM projects WHERE root_path IS NOT NULL AND (archived IS NULL OR archived = 0)`,
    [],
  );
  // Find the most specific (longest) root_path that contains the cwd
  let bestMatch: { id: string; len: number } | null = null;
  for (const row of rows) {
    const rootResolved = path.resolve(row.root_path);
    if (resolved === rootResolved || resolved.startsWith(rootResolved + path.sep)) {
      if (!bestMatch || rootResolved.length > bestMatch.len) {
        bestMatch = { id: row.id, len: rootResolved.length };
      }
    }
  }
  return bestMatch?.id ?? null;
}
