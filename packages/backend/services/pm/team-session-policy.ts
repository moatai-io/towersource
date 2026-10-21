import { resolveTeamAgentContext } from '../agent-workspaces/team-context.js';

export interface OwnTeamSessionInput {
  /** Authenticated actor and current Session/Agent facts, never request assertions. */
  userId: number;
  sessionOwnerId: number | null;
  agentProjectId: string;
  channelBound: boolean;
}

/** Compatibility owner-only helper. This alone cannot enforce nonowner revocation.
 * Callers must use resolveTeamSessionGate before accepting existing read/send
 * grants. Another owner/channel returns false without resolving context. A
 * confirmed teamless owner returns false; denied/DB failures propagate. This
 * supplies no audience, sharing, Project membership or action approval.
 */
export async function canUseOwnTeamSession(input: OwnTeamSessionInput): Promise<boolean> {
  if (input.sessionOwnerId !== input.userId || input.channelBound) return false;
  // No cache: every invocation resolves current membership and Agent/user state.
  return await resolveTeamAgentContext({ userId: input.userId, agentProjectId: input.agentProjectId }) !== null;
}

export type TeamSessionGateResult =
  | { kind: 'channel-excluded' }
  | { kind: 'legacy' }
  | { kind: 'team'; ownerAdmission: boolean };

/** Mandatory current-use prerequisite for non-channel reads AND resumption.
 * Every team actor, owner or nonowner, must retain Agent use even with existing
 * Project/internal-share rights. Revocation blocks past Session use, not deletion.
 * Only confirmed null returns legacy; policy and DB failures propagate. A valid
 * owner gets ownerAdmission, while nonowners must pass existing audience and
 * action guards. No audience, sharing or approval is granted by the gate itself.
 * Channels are explicitly excluded. Never catch denial into legacy fallback.
 */
export async function resolveTeamSessionGate(input: OwnTeamSessionInput): Promise<TeamSessionGateResult> {
  if (input.channelBound) return { kind: 'channel-excluded' };
  const context = await resolveTeamAgentContext({ userId: input.userId, agentProjectId: input.agentProjectId });
  if (context === null) return { kind: 'legacy' };
  return { kind: 'team', ownerAdmission: input.sessionOwnerId === input.userId };
}

type SessionVisibility = 'private' | 'project';

/** Pure opt-in creation policy, not wired into createSession.
 * hasTeamContext must come from a successful current server-side resolution;
 * false means confirmed teamless, NOT denied/unavailable team facts.
 * Explicit visibility must be separately validated/authorized by the caller;
 * explicit 'project' requires separate conversation-sharing approval.
 * Existing explicit Project audience and the caller's legacy default are retained;
 * only a team Agent's implicit creation default becomes private.
 */
export function resolveTeamSessionVisibility(input: {
  hasTeamContext: boolean;
  explicitVisibility?: SessionVisibility;
  legacyDefault: SessionVisibility;
}): SessionVisibility {
  return input.explicitVisibility ?? (input.hasTeamContext ? 'private' : input.legacyDefault);
}
