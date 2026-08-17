// Owns: engine-neutral root-turn terminal classification and authoritative wire projection.
// Public API: decideTurnTerminal, decidePiTurnTerminal, toTurnTerminalMessage. See README.md.

export type TurnTerminalOutcome =
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'waiting_retry'
  | 'needs_attention'
  | 'claim_denied';

export type EngineTerminalOutcome = 'completed' | 'retryable_failure' | 'failed' | 'claim_denied';
export type PiEngineTerminalOutcome = EngineTerminalOutcome;

export interface TurnTerminalEvidence {
  sessionId: string;
  rootTurnId: string;
  engineOutcome?: EngineTerminalOutcome;
  assistantMessageId?: string;
  stopMode?: 'safe' | 'force';
  error?: string;
  terminalAt?: string;
}

export interface PiTurnTerminalEvidence extends TurnTerminalEvidence {
  sessionId: string;
  rootTurnId: string;
  engineOutcome?: PiEngineTerminalOutcome;
}

export interface TurnTerminalDecision {
  sessionId: string;
  rootTurnId: string;
  outcome: TurnTerminalOutcome;
  reason:
    | 'durable_assistant_completed'
    | 'missing_durable_assistant'
    | 'retryable_engine_failure'
    | 'terminal_engine_failure'
    | 'safe_stop'
    | 'forced_stop'
    | 'recovery_claim_denied';
  terminalAt: string;
  assistantMessageId?: string;
  error?: string;
}

export interface TurnTerminalMessage extends TurnTerminalDecision {
  type: 'turn_terminal';
}

/**
 * Classify one settled Pi invocation without running recovery or mutating storage.
 * `completed` requires both an explicit completed engine outcome and the durable
 * assistant row that owns the final user-facing result.
 */
export function decideTurnTerminal(evidence: TurnTerminalEvidence): TurnTerminalDecision {
  const base = {
    sessionId: evidence.sessionId,
    rootTurnId: evidence.rootTurnId,
    terminalAt: evidence.terminalAt || new Date().toISOString(),
  };

  if (evidence.stopMode) {
    return {
      ...base,
      outcome: 'stopped',
      reason: evidence.stopMode === 'safe' ? 'safe_stop' : 'forced_stop',
      error: evidence.error,
    };
  }

  if (evidence.engineOutcome === 'claim_denied') {
    return { ...base, outcome: 'claim_denied', reason: 'recovery_claim_denied', error: evidence.error };
  }

  if (evidence.engineOutcome === 'retryable_failure') {
    return { ...base, outcome: 'waiting_retry', reason: 'retryable_engine_failure', error: evidence.error };
  }

  if (evidence.engineOutcome === 'failed') {
    return { ...base, outcome: 'needs_attention', reason: 'terminal_engine_failure', error: evidence.error };
  }

  if (evidence.engineOutcome === 'completed' && evidence.assistantMessageId) {
    return {
      ...base,
      outcome: 'completed',
      reason: 'durable_assistant_completed',
      assistantMessageId: evidence.assistantMessageId,
    };
  }

  return {
    ...base,
    outcome: 'needs_attention',
    reason: 'missing_durable_assistant',
    error: evidence.error || 'Pi invocation settled without an authoritative durable assistant result.',
  };
}

/** Backward-compatible Pi entry point; all engines now share the same classifier. */
export const decidePiTurnTerminal = decideTurnTerminal;

/** Convert the domain decision to the sole authoritative terminal wire event. */
export function toTurnTerminalMessage(decision: TurnTerminalDecision): TurnTerminalMessage {
  return { type: 'turn_terminal', ...decision };
}
