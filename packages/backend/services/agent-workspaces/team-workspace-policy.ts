/** Server-loaded current facts only; never request JSON or Session snapshots. */
export interface TeamWorkspacePolicyInput {
  currentUser: { active: boolean; role: string };
  /** Explicit, current memberships of currentUser (not Project memberships). */
  teamMemberships: ReadonlyArray<{ teamId: string; active: boolean }>;
  /** A running Agent belongs to at most one team. null is handled by the caller's legacy branch. */
  agent: { active: boolean; teamId: string | null };
  workspaces: ReadonlyArray<{
    workspaceId: string;
    teamId: string | null;
    registered: boolean;
    active: boolean;
  }>;
}

/** Pure team Agent-use admission; no Project membership facts are fabricated.
 * Server resolvers must branch: team Agents use this decision, teamless Agents retain
 * legacy Project-membership admission. Do not AND the legacy check onto team admission.
 * This does not grant Session audience, credentials, storage access or system authority.
 */
export function requireTeamAgentUse(
  input: Pick<TeamWorkspacePolicyInput, 'currentUser' | 'teamMemberships' | 'agent'>,
): void {
  const teamId = input.agent.teamId;
  if (!teamId?.trim()) throw new Error('TEAM_WORKSPACE_CONTEXT_REQUIRED');
  if (input.currentUser.active !== true || input.agent.active !== true
    || !['admin', 'operator', 'member'].includes(input.currentUser.role)
    || !input.teamMemberships.some(membership => membership.teamId === teamId && membership.active === true)) {
    throw new Error('TEAM_WORKSPACE_ACCESS_DENIED');
  }
}

/** Pure team-file inventory, NOT a storage grant or mount/isolation proof.
 * Registered storage resolution and file/tool/executor scope enforcement remain unconnected.
 * No host locator, Session authority, credential or organization fallback is returned.
 */
export function listTeamWorkspaceIds(input: TeamWorkspacePolicyInput): string[] {
  requireTeamAgentUse(input);
  const teamId = input.agent.teamId;
  const ids = new Set<string>();
  for (const workspace of input.workspaces) {
    // Stale/unregistered resources are excluded; only the Agent's single team is relevant.
    if (workspace.teamId !== teamId || workspace.active !== true || workspace.registered !== true) continue;
    if (!workspace.workspaceId.trim() || ids.has(workspace.workspaceId)) {
      throw new Error('TEAM_WORKSPACE_INVENTORY_INVALID');
    }
    ids.add(workspace.workspaceId);
  }
  return [...ids];
}
