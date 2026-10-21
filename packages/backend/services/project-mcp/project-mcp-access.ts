/** Fresh account/project authority; connection management is not execution access. */
import path from 'node:path';
import { isOperatorAccessProjectPath } from '../pm/project-access.js';
import { queryOne } from '../../db/pg-repo.js';
import { assertCredentialManagementAccess } from '../credential-vault/credential-management-access.js';

export class ProjectMcpAccessError extends Error {
  readonly status = 403;
  constructor() { super('Agent MCP access denied'); }
}
export async function assertProjectMcpAccess(projectId: string, userId: number): Promise<{ rootPath: string; role: string; membershipRole: string | null }> {
  const row = await queryOne<{ root_path: string; role: string; membership_role: string | null; user_id: number | null }>(
    `SELECT p.root_path, p.user_id, u.role, pm.role AS membership_role
     FROM projects p JOIN users u ON u.id = $2
     LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = u.id
     WHERE p.id = $1 AND COALESCE(p.archived, 0) = 0 AND COALESCE(p.lifecycle_status, 'active') = 'active'
       AND u.disabled = 0 AND COALESCE(u.approval_status, 'active') = 'active'`, [projectId, userId]);
  if (!row || !['admin', 'operator', 'member', 'viewer', 'guest'].includes(row.role) || !(row.role === 'admin' || row.membership_role
    || (row.role === 'operator' && await isOperatorAccessProjectPath(row.root_path, userId)))) throw new ProjectMcpAccessError();
  return { rootPath: row.root_path, role: row.role, membershipRole: row.membership_role };
}
export async function assertProjectMcpManager(projectId: string, userId: number): Promise<{ rootPath: string; role: string; membershipRole: string | null }> {
  const access = await assertProjectMcpAccess(projectId, userId);
  await assertCredentialManagementAccess({ actorUserId: userId, scope: 'project', projectId, action: 'write' });
  return access;
}

export async function assertProjectMcpExecution(projectId: string, userId: number, expectedRoot?: string): Promise<{ rootPath: string; role: string; membershipRole: string | null }> {
  const access = await assertProjectMcpAccess(projectId, userId);
  if (!['admin', 'operator', 'member'].includes(access.role) || (access.role !== 'admin' && ['viewer', 'guest'].includes(access.membershipRole ?? '')) || (expectedRoot && path.resolve(access.rootPath) !== path.resolve(expectedRoot))) throw new ProjectMcpAccessError();
  return access;
}
