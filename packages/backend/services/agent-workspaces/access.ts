import { queryOne } from '../../db/pg-repo.js';

export type WorkspaceOperation = 'read' | 'write';
export interface WorkspaceAccessFacts {
  user_role: string;
  user_disabled: number;
  agent_archived: number | null;
  agent_status: string | null;
  membership_role: string | null;
  workspace_state: string;
  owner_project_id: string | null;
  owner_root_path?: string | null;
  owner_archived: number | null;
  workspace_kind: string;
  grant_mode: string | null;
  grant_version: number | null;
  grant_revoked_at: string | null;
}

/** Pure decision; admin/operator entry does not grant extra workspace scopes. */
export function evaluateAgentWorkspaceAccess(agentProjectId: string, operation: WorkspaceOperation, f: WorkspaceAccessFacts) {
  if (!['read', 'write'].includes(operation)) throw new Error('WORKSPACE_OPERATION_INVALID');
  if (!['admin', 'operator', 'member', 'viewer', 'guest'].includes(f.user_role)
    || f.user_disabled !== 0 || (f.agent_archived !== null && f.agent_archived !== 0)
    || (f.agent_status !== null && !['active', 'ready'].includes(f.agent_status))) throw new Error('AGENT_ACCESS_DENIED');
  const manager = ['admin', 'operator'].includes(f.user_role);
  const member = ['owner', 'member', 'viewer'].includes(f.membership_role ?? '');
  if (!manager && !member) throw new Error('AGENT_ACCESS_DENIED');
  if (operation === 'write' && (['viewer', 'guest'].includes(f.user_role)
    || (!manager && !['owner', 'member'].includes(f.membership_role ?? '')))) throw new Error('AGENT_WRITE_DENIED');
  if (f.workspace_state !== 'active' || (f.owner_archived !== null && f.owner_archived !== 0)) throw new Error('WORKSPACE_UNAVAILABLE');
  if (!['project', 'shared-skills'].includes(f.workspace_kind)
    || (f.workspace_kind === 'project' && !f.owner_project_id)
    || (f.workspace_kind === 'shared-skills' && f.owner_project_id !== null)) throw new Error('WORKSPACE_CONFIGURATION_INVALID');
  const own = f.workspace_kind === 'project' && f.owner_project_id === agentProjectId;
  if (!own && (f.grant_revoked_at !== null || !['read', 'read-write'].includes(f.grant_mode ?? '')
    || !Number.isSafeInteger(f.grant_version) || Number(f.grant_version) < 1)) throw new Error('WORKSPACE_NOT_GRANTED');
  const mode = own ? 'read-write' : f.grant_mode as 'read' | 'read-write';
  if (operation === 'write' && mode !== 'read-write') throw new Error('WORKSPACE_READ_ONLY');
  return { mode, grantVersion: own ? null : f.grant_version, ownWorkspace: own };
}

/** No caching: account, membership and direct grant revocation are read per request.
 * Internal seam only. Not an OS boundary, storage resolver or authorization token.
 */
export async function requireAgentWorkspaceAccess(input: { userId: number; agentProjectId: string; workspaceId: string; operation: WorkspaceOperation }) {
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0 || !input.agentProjectId || !input.workspaceId) throw new Error('AGENT_WORKSPACE_CONTEXT_REQUIRED');
  const facts = await queryOne<WorkspaceAccessFacts>(`
    SELECT u.role AS user_role,u.disabled AS user_disabled,p.archived AS agent_archived,
           pap.status AS agent_status,pm.role AS membership_role,w.state AS workspace_state,
           w.owner_project_id,op.root_path AS owner_root_path,op.archived AS owner_archived,w.kind AS workspace_kind,
           g.mode AS grant_mode,g.version AS grant_version,g.revoked_at AS grant_revoked_at
      FROM users u JOIN projects p ON p.id=$2
      JOIN agent_workspaces w ON w.id=$3
      LEFT JOIN projects op ON op.id=w.owner_project_id
      LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=u.id
      LEFT JOIN project_agent_profiles pap ON pap.project_id=p.id
      LEFT JOIN agent_workspace_grants g ON g.agent_project_id=p.id AND g.workspace_id=w.id
     WHERE u.id=$1`, [input.userId, input.agentProjectId, input.workspaceId]);
  if (!facts) throw new Error('AGENT_WORKSPACE_ACCESS_DENIED');
  return { agentProjectId: input.agentProjectId, workspaceId: input.workspaceId,
    ownerProjectId: facts.owner_project_id, ownerRootPath: facts.owner_root_path ?? null, workspaceKind: facts.workspace_kind,
    ...evaluateAgentWorkspaceAccess(input.agentProjectId, input.operation, facts) };
}
