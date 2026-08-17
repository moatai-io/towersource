// Owns: compatibility facade for the durable root-turn supervisor.
// Public API: tryClaimAgentTurnRecovery, releaseAgentTurnRecovery, completeAgentTurnRecovery. See README.md.

import { claimAgentTurn, claimForegroundAgentTurn, renewAgentTurnClaim, settleAgentTurn } from './turn-supervisor.js';

export type AgentTurnRecoveryClaim = {
  claimed: boolean;
  token?: string;
  attempt?: number;
  status?: string;
};

/** A normal user turn acquires the same fencing token without incrementing recovery attempts. */
export async function tryClaimForegroundAgentTurn(params: {
  rootTurnId: string;
  sessionId: string;
  ownerBootId: string;
  leaseSeconds?: number;
}): Promise<AgentTurnRecoveryClaim> {
  const claim = await claimForegroundAgentTurn(params);
  return {
    claimed: claim.claimed,
    token: claim.token,
    attempt: 0,
    status: claim.state,
  };
}

/** All automatic continuation sources claim the same durable root turn. */
export async function tryClaimAgentTurnRecovery(params: {
  rootTurnId: string;
  sessionId: string;
  source: string;
  ownerBootId: string;
  takeoverPreviousBoot?: boolean;
  leaseSeconds?: number;
  maxAttempts?: number;
}): Promise<AgentTurnRecoveryClaim> {
  const claim = await claimAgentTurn(params);
  return {
    claimed: claim.claimed,
    token: claim.token,
    attempt: claim.attempt,
    status: claim.state,
  };
}

/** Keep one long-running recovery owner authoritative. */
export async function renewAgentTurnRecovery(params: {
  rootTurnId: string;
  token: string;
  ownerBootId: string;
  leaseSeconds?: number;
}): Promise<boolean> {
  return renewAgentTurnClaim(params);
}

/** A generation/provider failure can be retried later; it is not an uncertain side effect. */
export async function releaseAgentTurnRecovery(params: {
  rootTurnId: string;
  token: string;
  error?: string;
  failureClass?: string;
  retryDelaySeconds?: number;
  attempt?: number;
  maxAttempts?: number;
}): Promise<boolean> {
  const exhausted = (params.attempt ?? 0) >= (params.maxAttempts ?? 4);
  return settleAgentTurn({
    rootTurnId: params.rootTurnId,
    token: params.token,
    state: exhausted ? 'needs_attention' : 'waiting_retry',
    error: params.error,
    failureClass: params.failureClass,
    retryDelaySeconds: params.retryDelaySeconds,
  });
}

/** Mark a fenced recovery terminal. `uncertain` requires explicit attention, never automatic replay. */
export async function completeAgentTurnRecovery(params: {
  rootTurnId: string;
  token: string;
  status: 'completed' | 'failed' | 'uncertain';
  error?: string;
  assistantMessageId?: string;
}): Promise<boolean> {
  return settleAgentTurn({
    rootTurnId: params.rootTurnId,
    token: params.token,
    state: params.status === 'uncertain' ? 'needs_attention' : params.status,
    error: params.error,
    assistantMessageId: params.assistantMessageId,
  });
}
