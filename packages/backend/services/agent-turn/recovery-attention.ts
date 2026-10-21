import type { AgentTurnState } from './turn-supervisor.js';

/** Preserve durable outcomes; superseded recovery does not require user action. */
export function projectRecoveryAttention(state: AgentTurnState, failureClass: string | null, lastError: string | null) {
  const superseded = state === 'needs_attention' && failureClass === 'restart_recovery_superseded';
  return { state, lastError, requiresAttention: (state === 'needs_attention' || state === 'failed') && !superseded,
    recoveryDisposition: superseded ? 'superseded' as const : null };
}
