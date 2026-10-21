/** Human entry checks for Credential management, independent of model trust. */
import { queryOne } from '../../db/pg-repo.js';
import { authorizeTowerAction } from '../authority/authorization-policy.js';

export class CredentialManagementDeniedError extends Error {
  readonly code = 'CREDENTIAL_MANAGEMENT_DENIED';
  constructor() { super('Credential management access denied'); }
}

export async function assertCredentialManagementAccess(input: {
  actorUserId: number;
  scope: 'project' | 'workspace';
  projectId?: string | null;
  action?: 'write' | 'reveal' | 'admin';
}): Promise<void> {
  if (input.scope !== 'project' && input.scope !== 'workspace') throw new CredentialManagementDeniedError();
  // Fresh role/account state is essential for long-lived tool sessions as well as HTTP.
  const actor = await queryOne<{ role: string }>(
    `SELECT role FROM users WHERE id = $1 AND disabled = 0 AND COALESCE(approval_status, 'active') = 'active'`,
    [input.actorUserId],
  );
  if (!actor) throw new CredentialManagementDeniedError();
  let projectOwner = false;
  let projectMember = false;
  if (input.scope === 'project') {
    if (!input.projectId) throw new CredentialManagementDeniedError();
    const project = await queryOne<{ membership_role: string | null }>(
      `SELECT pm.role AS membership_role
         FROM projects p LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
        WHERE p.id = $1`, [input.projectId, input.actorUserId],
    );
    if (!project) throw new CredentialManagementDeniedError();
    // Creation is historical attribution, not an irrevocable management grant.
    // Removed membership must stay revoked; do not fall back to projects.user_id.
    projectOwner = project.membership_role === 'owner';
    projectMember = ['owner', 'admin', 'member'].includes(project.membership_role ?? '');
  }
  const decision = authorizeTowerAction({
    role: actor.role, resource: 'credential', action: input.action ?? 'write',
    facts: { scope: input.scope, projectOwner, projectMember, projectWritable: projectMember },
  });
  if (!decision.allowed) throw new CredentialManagementDeniedError();
}
