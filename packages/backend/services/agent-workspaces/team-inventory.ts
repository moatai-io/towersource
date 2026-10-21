import { loadTeamWorkspacePolicyInput, requireCurrentTeamFacts } from './team-repository.js';
import { listTeamWorkspaceIds } from './team-workspace-policy.js';

/** Internal logical inventory; current facts and inventory share one SQL snapshot.
 * No routes/executors activated. A snapshot is not an atomic execution/revocation guarantee.
 * null retains the existing eligible teamless caller branch.
 */
export async function listCurrentTeamWorkspaces(input: { userId: number; agentProjectId: string }) {
  const facts = await loadTeamWorkspacePolicyInput(input);
  requireCurrentTeamFacts(facts);
  if (facts.agent.teamId === null) return null;
  const allowedIds = new Set(listTeamWorkspaceIds(facts));
  return facts.workspaces.filter(workspace => allowedIds.has(workspace.workspaceId))
    .map(workspace => ({ workspaceId: workspace.workspaceId, ownerProjectId: workspace.ownerProjectId }));
}
