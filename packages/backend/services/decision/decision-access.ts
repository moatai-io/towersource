import { requireCurrentAgentExecutionAccess } from '../authority/agent-execution-access.js';
import { requireBoundDecisionSpec, type DecisionPrincipal } from './decision-spec-repository.js';
import type { DecisionSpec } from './decision-spec.js';

/** Resolve a spec only after checking current server-side Project execution facts and explicit binding. */
export async function requireDecisionSpecAccess(input: {
  projectId: string;
  userId: number;
  principal: DecisionPrincipal;
  specId: string;
  specRevision?: number;
}): Promise<DecisionSpec> {
  await requireCurrentAgentExecutionAccess({ projectId: input.projectId, userId: input.userId });
  return requireBoundDecisionSpec({
    projectId: input.projectId,
    principal: input.principal,
    specId: input.specId,
    specRevision: input.specRevision,
  });
}
