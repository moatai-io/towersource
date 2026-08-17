/**
 * Owns: pure Tower-side lifecycle rules for Pi agent runs.
 * Public API: PiRunState, PiRunPhase, markPiRunClosing, classifyPiSteer.
 *
 * Pi SDK/provider streams are raw signals, not the source of truth for Tower's
 * user-facing run lifecycle. These helpers keep the crucial state-machine rules
 * testable without constructing a real Pi SDK AgentSession.
 * See: GitHub issue #55.
 */

export type PiRunState =
  | 'starting'
  | 'running'
  | 'tool_running'
  | 'stalled'
  | 'closing'
  | 'closed'
  | 'error';

// Back-compat name used by PiEngine. Phase 2 standardizes the vocabulary on
// PiRunState while keeping the old exported type name so call sites can migrate
// without a broad mechanical rename.
export type PiRunPhase = PiRunState;

export type PiSteerDisposition =
  | { kind: 'deliver' }
  | { kind: 'buffer' }
  | { kind: 'reject'; reason: 'closing' | 'idle' | 'inactive'; message: string };

export function isTerminalRunState(state: PiRunState | undefined): boolean {
  return state === 'closed' || state === 'error';
}

export function canAcceptSteer(input: { state?: PiRunState; promptActive?: boolean }): boolean {
  return !!input.promptActive && (input.state === 'running' || input.state === 'tool_running');
}

export function shouldBufferInput(input: { state?: PiRunState; isRunning?: boolean; isStarting?: boolean; promptActive?: boolean }): boolean {
  return !input.promptActive && (!!input.isStarting || (!!input.isRunning && input.state === 'starting'));
}

/** Move a run into closing unless it is already terminal. */
export function markPiRunClosing(phase: PiRunPhase | undefined): PiRunPhase {
  return isTerminalRunState(phase) ? (phase ?? 'closed') : 'closing';
}

/**
 * Decide whether a user message may be delivered as a mid-turn steer.
 *
 * Contract:
 * - only an active prompt in state='running' or state='tool_running' may receive real steers
 * - startup steers may buffer while the run is claimed but prompt() is not ready
 * - closing/zombie runs must reject so ws-handler falls back to post-turn queue
 */
export function classifyPiSteer(input: {
  phase?: PiRunPhase;
  promptActive?: boolean;
  isRunning?: boolean;
  isStarting?: boolean;
}): PiSteerDisposition {
  const state = input.phase;

  if (state === 'closing') {
    return {
      kind: 'reject',
      reason: 'closing',
      message: 'Pi run is closing; cannot steer. Queue this message for the next turn.',
    };
  }

  if (canAcceptSteer({ state, promptActive: input.promptActive })) return { kind: 'deliver' };

  if (input.promptActive) {
    return {
      kind: 'reject',
      reason: 'inactive',
      message: `Pi run is not active (state=${state ?? 'unknown'}); cannot steer.`,
    };
  }

  if (shouldBufferInput({ state, isRunning: input.isRunning, isStarting: input.isStarting, promptActive: input.promptActive })) {
    return { kind: 'buffer' };
  }

  return {
    kind: 'reject',
    reason: 'idle',
    message: 'Pi session is not currently running; cannot steer.',
  };
}
