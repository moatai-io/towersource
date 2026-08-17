// Owns: frontend projection of authoritative Pi root-turn terminal events.
// Public API: TurnTerminalProjection, applyTurnTerminal. See README.md.

export type TurnTerminalOutcome =
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'waiting_retry'
  | 'needs_attention'
  | 'claim_denied';

export interface TurnTerminalProjection {
  rootTurnId: string;
  outcome: TurnTerminalOutcome;
  terminalAt: number;
  assistantMessageId?: string;
  reason?: string;
  error?: string;
  read: boolean;
}

export interface TurnTerminalEvent {
  rootTurnId: string;
  outcome: TurnTerminalOutcome;
  terminalAt: string | number;
  assistantMessageId?: string;
  reason?: string;
  error?: string;
}

/** Apply terminal facts idempotently; older root-turn results never replace newer ones. */
export function applyTurnTerminal(
  current: TurnTerminalProjection | undefined,
  event: TurnTerminalEvent,
  read: boolean,
): TurnTerminalProjection {
  const parsedAt = typeof event.terminalAt === 'number' ? event.terminalAt : Date.parse(event.terminalAt);
  const terminalAt = Number.isFinite(parsedAt) ? parsedAt : Date.now();
  if (current && current.rootTurnId !== event.rootTurnId && current.terminalAt > terminalAt) return current;
  if (current && current.rootTurnId === event.rootTurnId && current.terminalAt > terminalAt) return current;

  return {
    rootTurnId: event.rootTurnId,
    outcome: event.outcome,
    terminalAt,
    assistantMessageId: event.assistantMessageId,
    reason: event.reason,
    error: event.error,
    read,
  };
}
