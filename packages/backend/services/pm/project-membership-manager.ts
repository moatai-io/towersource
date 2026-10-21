/*
 * Owns: project membership and project access-list helpers.
 * Public API: project member CRUD, default membership seeding, accessible project IDs.
 * See: project-access.ts for request/tool-level enforcement.
 */
import { query, queryOne, execute } from '../../db/pg-repo.js';

export interface ProjectMember {
  userId: number;
  username: string;
  role: string;
  addedAt: string;
}

export async function getProjectMembers(projectId: string): Promise<ProjectMember[]> {
  // IMPORTANT: PostgreSQL folds unquoted identifiers to lowercase, so camelCase
  // aliases MUST be double-quoted. Without quotes, "as userId" becomes column
  // "userid" in the result row, and any frontend code doing `m.userId` sees
  // undefined — breaking member deduplication in invite dropdowns.
  return await query<ProjectMember>(`
    SELECT pm.user_id AS "userId", u.username, pm.role, pm.added_at AS "addedAt"
    FROM project_members pm
    JOIN users u ON u.id = pm.user_id
    WHERE pm.project_id = $1 AND u.disabled = 0
    ORDER BY pm.role DESC, u.username
  `, [projectId]);
}

export async function addProjectMember(projectId: string, userId: number, role = 'member'): Promise<void> {
  await execute(
    'INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [projectId, userId, role]
  );
  // Invalidate path cache so new access is immediately available.
  try { const { invalidatePathCache } = await import('./project-access.js'); invalidatePathCache(userId); } catch {}
}

export async function removeProjectMember(projectId: string, userId: number): Promise<boolean> {
  // Prevent removing last owner.
  const ownerCountRow = await queryOne<any>(
    `SELECT COUNT(*) as cnt FROM project_members WHERE project_id = $1 AND role = 'owner'`,
    [projectId]
  );
  const ownerCount = ownerCountRow?.cnt ?? 0;
  const isOwner = await queryOne(
    `SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2 AND role = 'owner'`,
    [projectId, userId]
  );
  if (isOwner && ownerCount <= 1) return false;

  await execute('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
  // Invalidate path cache so access is immediately revoked.
  try { const { invalidatePathCache } = await import('./project-access.js'); invalidatePathCache(userId); } catch {}
  return true;
}

export async function isProjectOwner(projectId: string, userId: number): Promise<boolean> {
  const row = await queryOne(
    `SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2 AND role = 'owner'`,
    [projectId, userId]
  );
  return !!row;
}

export async function isProjectMember(projectId: string, userId: number, operation: 'read' | 'write' = 'read'): Promise<boolean> {
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;
  const row = await queryOne(
    `SELECT 1 FROM project_members pm JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = $1 AND pm.user_id = $2 AND u.disabled = 0
       AND u.role IN ('admin', 'operator', 'member', 'viewer', 'guest')
       ${operation === 'write' ? "AND pm.role IN ('owner', 'member') AND u.role IN ('admin', 'operator', 'member')" : ''}`,
    [projectId, userId]
  );
  return !!row;
}

/**
 * Auto-seed all active admin/operator/member users as members of a project.
 * viewer/guest are explicit-invite only.
 *
 * Used for system-owned default shared projects, not for ordinary project
 * creation. Idempotent — uses ON CONFLICT DO NOTHING.
 */
export async function autoSeedProjectMembers(projectId: string): Promise<number> {
  const result = await execute(`
    INSERT INTO project_members (project_id, user_id, role)
    SELECT $1, u.id, 'member'
    FROM users u
    WHERE u.disabled = 0 AND u.role IN ('admin', 'operator', 'member')
      AND EXISTS (SELECT 1 FROM projects p WHERE p.id = $1 AND p.user_id IS NULL
        AND p.system_key IN ('general', 'introduction')
        AND COALESCE(p.archived, 0) = 0 AND COALESCE(p.lifecycle_status, 'active') = 'active')
    ON CONFLICT DO NOTHING
  `, [projectId]);
  return result.changes;
}

/**
 * Auto-seed a newly-created user only into explicit public system projects.
 * viewer/guest are explicit-invite only.
 */
export async function autoSeedUserMemberships(userId: number, role: string): Promise<number> {
  if (!['admin', 'operator', 'member'].includes(role)) return 0;
  const result = await execute(`
    INSERT INTO project_members (project_id, user_id, role)
    SELECT p.id, $1, 'member'
    FROM projects p
    WHERE p.user_id IS NULL AND p.system_key IN ('general', 'introduction')
      AND COALESCE(p.archived, 0) = 0 AND COALESCE(p.lifecycle_status, 'active') = 'active'
      AND EXISTS (SELECT 1 FROM users u WHERE u.id = $1 AND u.disabled = 0
        AND u.role IN ('admin', 'operator', 'member'))
    ON CONFLICT DO NOTHING
  `, [userId]);
  try { const { invalidatePathCache } = await import('./project-access.js'); invalidatePathCache(userId); } catch {}
  return result.changes;
}

/**
 * Return active project IDs granted by current explicit membership. Neither
 * operational role nor legacy creator metadata may recreate a revoked invite.
 */
export async function getProjectMembershipIds(userId: number): Promise<string[]> {
  if (!Number.isSafeInteger(userId) || userId <= 0) return [];
  const rows = await query<{ id: string }>(`
    SELECT p.id FROM projects p
    JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
    JOIN users u ON u.id = pm.user_id
    WHERE COALESCE(p.archived, 0) = 0 AND COALESCE(p.lifecycle_status, 'active') = 'active'
      AND u.disabled = 0 AND u.role IN ('admin', 'operator', 'member', 'viewer', 'guest')
  `, [userId]);
  return rows.map(r => r.id);
}

/** Operational roles do not grant content access; only current membership does. */
export async function getAccessibleProjectIds(userId: number, _role: string): Promise<string[]> {
  return getProjectMembershipIds(userId);
}
