import { queryOne } from '../../db/pg-repo.js';
import { listTeamWorkspaceIds, requireTeamAgentUse, type TeamWorkspacePolicyInput } from './team-workspace-policy.js';

export interface TeamRepositoryContext { userId: number; agentProjectId: string }
/** Resolved logical ownership metadata, never a storage locator or authority grant. */
export interface ResolvedTeamWorkspaceFacts extends Omit<TeamWorkspacePolicyInput, 'workspaces'> {
  workspaces: ReadonlyArray<TeamWorkspacePolicyInput['workspaces'][number] & { ownerProjectId: string }>;
}

/** Internal current facts, not a public discovery API or bearer authorization.
 * One statement provides a consistent snapshot; nothing is cached or auto-seeded.
 * Teamless facts are returned for the caller's explicit legacy branch. Missing,
 * archived or denied team contexts must never fall back to organization admission.
 */
export async function loadTeamWorkspacePolicyInput(
  input: TeamRepositoryContext,
  options: { includeInventory?: boolean } = {},
): Promise<ResolvedTeamWorkspaceFacts> {
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0
    || typeof input.agentProjectId !== 'string' || !input.agentProjectId.trim() || input.agentProjectId.length > 200) {
    throw new Error('TEAM_WORKSPACE_CONTEXT_REQUIRED');
  }
  const includeInventory = options.includeInventory !== false;
  const inventorySql = includeInventory ? `COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'workspaceId', inventory.id, 'ownerProjectId', inventory.owner_project_id,
        'teamId', tp.team_id, 'registered', true, 'active', true) ORDER BY inventory.id)
        FROM (
          SELECT w.id, w.owner_project_id FROM agent_workspaces w
          JOIN active_agents source_agent ON source_agent.id=w.owner_project_id
          JOIN agent_team_projects source_team ON source_team.project_id=source_agent.id
          WHERE source_team.team_id=tp.team_id AND t.state='active'
            AND w.kind='project' AND w.state='active'
          ORDER BY w.id LIMIT 257
        ) inventory), '[]'::jsonb)` : "'[]'::jsonb";
  const row = await queryOne<{
    user_active: boolean; user_role: string; agent_active: boolean;
    team_id: string | null; team_member: boolean; workspaces: ResolvedTeamWorkspaceFacts['workspaces'];
  }>(`WITH active_agents AS (
      SELECT p.id FROM projects p
      JOIN project_agent_profiles pap ON pap.project_id=p.id
      WHERE p.archived=0 AND p.lifecycle_status='active' AND pap.status IN ('active','ready')
    )
    SELECT (u.disabled=0 AND u.approval_status='active') AS user_active, u.role AS user_role,
      (CASE WHEN tp.team_id IS NULL THEN p.archived=0 AND p.lifecycle_status='active'
        ELSE a.id IS NOT NULL AND t.state='active' END) AS agent_active,
      tp.team_id,
      EXISTS (SELECT 1 FROM agent_team_members tm
              WHERE tm.team_id=tp.team_id AND tm.user_id=u.id
                AND tm.state='active' AND t.state='active') AS team_member,
      ${inventorySql} AS workspaces
    FROM users u JOIN projects p ON p.id=$1
    LEFT JOIN active_agents a ON a.id=p.id
    LEFT JOIN agent_team_projects tp ON tp.project_id=p.id
    LEFT JOIN agent_teams t ON t.id=tp.team_id
    WHERE u.id=$2`, [input.agentProjectId, input.userId]);
  if (!row) throw new Error('TEAM_WORKSPACE_ACCESS_DENIED');
  if (includeInventory && row.workspaces.length > 256) throw new Error('TEAM_WORKSPACE_INVENTORY_LIMIT');
  return {
    currentUser: { active: row.user_active === true, role: row.user_role },
    agent: { active: row.agent_active === true, teamId: row.team_id },
    teamMemberships: row.team_id === null ? [] : [{ teamId: row.team_id, active: row.team_member === true }],
    workspaces: includeInventory ? row.workspaces : [],
  };
}

/** Team context admission shared by adapters, not a legacy execution grant.
 * Teamless accounts/Projects must be current and active; legacy callers still
 * decide role, profile, Project membership and Session audience independently.
 */
export function requireCurrentTeamFacts(facts: ResolvedTeamWorkspaceFacts): void {
  if (!facts.currentUser.active || !facts.agent.active) {
    throw new Error('TEAM_WORKSPACE_ACCESS_DENIED');
  }
  if (facts.agent.teamId !== null) requireTeamAgentUse(facts);
}

/** Only workspace IDs. Does not grant Session, credential, system, file-write or mount authority. */
export async function listCurrentTeamWorkspaceIds(input: TeamRepositoryContext): Promise<string[]> {
  return listTeamWorkspaceIds(await loadTeamWorkspacePolicyInput(input));
}
