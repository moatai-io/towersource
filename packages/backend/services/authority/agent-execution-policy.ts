/**
 * Project Agent execution identity, separate from the human entrance decision.
 *
 * This is attribution and a narrowing contract, not proof of OS isolation. Only
 * server-resolved Project/Worker bindings grant compute; roles, prompts and
 * caller-supplied request fields cannot grant a different execution identity.
 */
export const AGENT_EXECUTION_POLICY_ID = 'tower.agent-execution.authority.v1';

export interface AgentExecutionIdentity {
  policyId: typeof AGENT_EXECUTION_POLICY_ID;
  principal: { kind: 'agent'; projectId: string };
  requester: { userId: number; sessionId: string };
  scope: 'project';
}

/** Caller must first validate the current account and Agent-use access. No role is consumed here. */
export function resolveProjectAgentExecutionIdentity(input: {
  projectId: string;
  userId: number;
  sessionId: string;
}): AgentExecutionIdentity {
  if (typeof input.projectId !== 'string' || !input.projectId.trim()
    || !Number.isSafeInteger(input.userId) || input.userId <= 0
    || typeof input.sessionId !== 'string' || !input.sessionId.trim()) {
    throw new Error('AGENT_EXECUTION_IDENTITY_INVALID');
  }
  return {
    policyId: AGENT_EXECUTION_POLICY_ID,
    principal: { kind: 'agent', projectId: input.projectId },
    requester: { userId: input.userId, sessionId: input.sessionId },
    scope: 'project',
  };
}
