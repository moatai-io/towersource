/**
 * sandbox-acl.ts — sandbox workspace_path 검사 공통 헬퍼.
 *
 * Owns: 멤버 이하 사용자가 마운트할 수 있는 workspace_path 의 정책.
 * Public API: assertSandboxWorkspaceAllowed (DB-touching), checkSandboxWorkspaceAllowed (pure).
 *
 * sandbox.ts (Mode B `run`) 와 sandbox-tools.ts (Mode C `tool_start`) 둘 다
 * 같은 검사 로직을 사용. 4계층 토글의 4단계 (workspace_path 검사) 위치.
 *
 *   1. admin / operator → 무제한
 *   2. config.sandbox.memberWorkspacePrefixes 화이트리스트 통과 (default: sandbox-tools/, projects/)
 *   3. workspace_path 가 projects/<slug>/... 형태면 추가로:
 *      slug 가 user 가 멤버인 프로젝트여야 함 (getUserAccessiblePaths 사용).
 *      자기가 owner / 초대된 멤버 OK, 비멤버 차단.
 *
 * 이 정책은 sandbox.ts:194 의 Phase 2 plan ("project membership 검증은 Phase 2 에서
 * project_members 테이블 통합 시 추가") 의 완성 — "멤버 간 코드 공유는 의도된 시나리오"
 * 라는 초기 가정이 multi-tenant 환경에서 너무 느슨함이 확인되어 좁힘.
 *
 * 결정: workspace/decisions/2026-05-12-sandbox-member-project-membership.md
 */

import * as path from 'path';
import { config } from '../../config.js';
import { getPgPool } from '../../db/pg.js';
import { SandboxDeniedError } from './sandbox.js';
import { getUserAccessiblePaths, isPrivilegedRole } from '../pm/project-access.js';

const PROJECTS_PREFIX = 'projects/';

export interface SandboxAclCheckInput {
  /** User role: 'admin' | 'operator' | 'member' | 'viewer' | 'guest'. */
  role: string;
  /** workspace-root-relative path (e.g. 'projects/foo' or 'sandbox-tools/3'). */
  workspacePath: string;
  /** From config.sandbox.memberWorkspacePrefixes. */
  allowedPrefixes: string[];
  /** Absolute filesystem root for resolving workspacePath (config.workspaceRoot). */
  workspaceRoot: string;
  /**
   * User's accessible project root_paths from getUserAccessiblePaths().
   * `null` = privileged (admin/operator) — bypass project membership check.
   * Empty array = non-privileged user with no project access.
   */
  accessiblePaths: string[] | null;
}

export type SandboxAclResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Pure, DB-free workspace_path policy check. Use this from tests.
 * Production callers should use assertSandboxWorkspaceAllowed() which does
 * the DB lookups for `role` and `accessiblePaths` and then calls this.
 */
export function checkSandboxWorkspaceAllowed(input: SandboxAclCheckInput): SandboxAclResult {
  if (isPrivilegedRole(input.role)) return { allowed: true };

  // 1. Prefix 화이트리스트 (legacy guard — still useful as a coarse filter)
  const prefixOk = input.allowedPrefixes.some((p) => input.workspacePath.startsWith(p));
  if (!prefixOk) {
    return {
      allowed: false,
      reason:
        `workspace_path "${input.workspacePath}" not in allowed prefixes for role=${input.role}: ` +
        input.allowedPrefixes.join(', '),
    };
  }

  // 2. projects/<slug>/ 면 추가로 membership 검사
  if (input.workspacePath.startsWith(PROJECTS_PREFIX)) {
    const rest = input.workspacePath.slice(PROJECTS_PREFIX.length);
    const slug = rest.split('/')[0];
    if (!slug || slug === '..' || slug === '.') {
      return {
        allowed: false,
        reason: `workspace_path "${input.workspacePath}" — invalid project slug`,
      };
    }

    // accessiblePaths === null is the "privileged" sentinel from
    // getUserAccessiblePaths(). Defensive — we already passed the privileged
    // role check above, so this branch shouldn't fire for non-privileged.
    if (input.accessiblePaths === null) return { allowed: true };

    const absPath = path.resolve(input.workspaceRoot, input.workspacePath);
    const allowed = input.accessiblePaths.some((root) => {
      const r = path.resolve(root);
      return absPath === r || absPath.startsWith(r + path.sep);
    });
    if (!allowed) {
      return {
        allowed: false,
        reason:
          `workspace_path "${input.workspacePath}" — you are not a member of project "${slug}". ` +
          `Ask the project owner to add you (Admin → Users → projects), or use one of your own projects.`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Production entry point — looks up role + accessible paths from DB, then
 * delegates to checkSandboxWorkspaceAllowed().
 *
 * Throws SandboxDeniedError on policy violation (matches existing call-site
 * expectations in sandbox.ts and sandbox-tools.ts).
 */
export async function assertSandboxWorkspaceAllowed(
  userId: number,
  workspacePath: string,
): Promise<void> {
  const pool = getPgPool();
  const { rows } = await pool.query<{ role: string }>(
    'SELECT role FROM users WHERE id = $1',
    [userId],
  );
  if (rows.length === 0) throw new SandboxDeniedError(`user ${userId} not found`);
  const role = rows[0].role;

  // Privileged roles: skip the (potentially expensive) accessible-paths lookup.
  if (isPrivilegedRole(role)) return;

  const accessiblePaths = await getUserAccessiblePaths(userId, role);
  const result = checkSandboxWorkspaceAllowed({
    role,
    workspacePath,
    allowedPrefixes: config.sandbox.memberWorkspacePrefixes,
    workspaceRoot: config.workspaceRoot,
    accessiblePaths,
  });
  if (!result.allowed) throw new SandboxDeniedError(result.reason);
}
