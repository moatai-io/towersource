import { loadTeamWorkspacePolicyInput, requireCurrentTeamFacts } from './team-repository.js';

/** Internal current-facts resolver; no routes/executors activated.
 * null means an active existing teamless Project, not execution or Session permission.
 * Legacy callers retain role/profile/membership/audience checks; denied current facts
 * never fall back. Context admission does not load inventory or inherit its size limit.
 */
export async function resolveTeamAgentContext(input: { userId: number; agentProjectId: string }) {
  const facts = await loadTeamWorkspacePolicyInput(input, { includeInventory: false });
  requireCurrentTeamFacts(facts);
  if (facts.agent.teamId === null) return null;
  return { agentProjectId: input.agentProjectId, teamId: facts.agent.teamId, userId: input.userId };
}
