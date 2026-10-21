/** Current server facts at execution time; never trusts a Session role snapshot. */
import { resolveTeamAgentContext } from '../agent-workspaces/team-context.js';
import { queryOne } from '../../db/pg-repo.js';
import { authorizeTowerAction } from './authorization-policy.js';

export async function requireCurrentAgentExecutionAccess(input: { projectId?: string; userId?: number; executionScope?: 'project' | 'organization' }) {
  if (!input.projectId || !Number.isSafeInteger(input.userId) || Number(input.userId) <= 0) {
    throw new Error('AGENT_EXECUTION_CONTEXT_REQUIRED');
  }
  if (input.executionScope !== undefined && input.executionScope !== 'project') {
    throw new Error('EXECUTION_SCOPE_UNSUPPORTED');
  }
  if (process.env.TOWER_TEAM_WORKSPACES_ENABLED === '1') {
    const team = await resolveTeamAgentContext({ userId: input.userId!, agentProjectId: input.projectId });
    // Team membership is not Project membership; no legacy/host fallback until
    // the executor consumes and enforces the same team workspace inventory.
    if (team) throw new Error('TEAM_EXECUTOR_NOT_READY');
  }
  const row = await queryOne<{
    role: string; disabled: number; archived: number | null; membership_role: string | null; agent_status: string | null;
  }>(`SELECT u.role, u.disabled, p.archived, pm.role AS membership_role, pap.status AS agent_status
       FROM users u JOIN projects p ON p.id = $1
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = u.id
       LEFT JOIN project_agent_profiles pap ON pap.project_id = p.id
      WHERE u.id = $2`, [input.projectId, input.userId]);
  if (!row || row.disabled !== 0 || (row.archived !== null && row.archived !== 0)
    || (row.agent_status !== null && !['active', 'ready'].includes(row.agent_status))) {
    throw new Error('AGENT_EXECUTION_INACTIVE');
  }
  const projectOwner = row.membership_role === 'owner';
  const projectMember = projectOwner || row.membership_role === 'member';
  const facts = { projectOwner, projectMember, projectWritable: projectMember,
    executionScope: 'project' as const };
  const decision = authorizeTowerAction({ role: row.role, resource: 'worker', action: 'execute', facts });
  if (!decision.allowed) throw new Error(`AGENT_EXECUTION_ACCESS_DENIED: ${decision.reason}`);
  return { userRole: row.role, ...facts };
}
