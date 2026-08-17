// Owns: common claim, selected primitive execution, retry settling, and failure mapping for Pi continuation.
// Public API: runPiContinuationRecovery, settlePiRecoveryOutcome. See README.md.

export type PiContinuationTrigger = 'post_compact' | 'transient' | 'incomplete';

export type PiRecoverySettlementOutcome = 'completed' | 'failed' | 'retryable_failure';

export interface PiRecoverySettlementResult {
  outcome: PiRecoverySettlementOutcome;
  error?: string;
}

export interface PiRecoverySettlementCallbacks {
  complete(status: 'completed' | 'failed' | 'uncertain', error?: string): Promise<void>;
  release(error: string): Promise<void>;
  isUnavailable(error: string): boolean;
}

export interface PiContinuationRecoveryResult {
  recovered: boolean;
  outcome: 'completed' | 'no_result' | 'transient_failure' | 'unavailable' | 'failed' | 'claim_denied';
  error?: string;
}

export interface PiContinuationRecoveryCallbacks {
  claim(source: string): Promise<boolean>;
  prepare(): void;
  execute(reason: string): Promise<void>;
  settleRetries(): Promise<boolean>;
  hasDurableAssistant(): boolean;
  noResultError(): string;
  complete(): Promise<void>;
  release(error: string): Promise<void>;
  settleUnavailable(error: string): Promise<void>;
  surfaceTransient(source: string, error: string): void;
  emitFailure(error: string): void;
  isTransient(error: string): boolean;
  isUnavailable(error: string): boolean;
  log(message: string): void;
}

/** Settles an already-claimed recovery after its selected execution path finishes. */
export async function settlePiRecoveryOutcome(params: {
  executionError?: string;
  aborted: boolean;
  durableAssistant: boolean;
  stopReason?: string;
  noResultError: string;
  callbacks: PiRecoverySettlementCallbacks;
}): Promise<PiRecoverySettlementResult> {
  const { executionError, aborted, durableAssistant, stopReason, noResultError, callbacks } = params;
  if (!executionError && stopReason === 'stop' && durableAssistant) {
    await callbacks.complete('completed');
    return { outcome: 'completed' };
  }

  const error = executionError || noResultError;
  if (aborted) {
    await callbacks.complete('failed', error);
    return { outcome: 'failed', error };
  }
  if (callbacks.isUnavailable(error)) {
    await callbacks.complete('uncertain', error);
    return { outcome: 'failed', error };
  }
  await callbacks.release(error);
  return { outcome: 'retryable_failure', error };
}

/** Executes one already-approved recovery primitive with consistent settlement. */
export async function runPiContinuationRecovery(params: {
  trigger: PiContinuationTrigger;
  source: string;
  failureMessage: string;
  callbacks: PiContinuationRecoveryCallbacks;
}): Promise<PiContinuationRecoveryResult> {
  const { trigger, source, failureMessage, callbacks } = params;
  const claimPrefix = trigger === 'post_compact' ? 'post-compact' : trigger;
  const failurePrefix = trigger === 'post_compact'
    ? 'post-compact-continuation'
    : trigger === 'incomplete'
      ? 'incomplete-turn-continuation'
      : 'transient-continuation';
  const claimSource = `${claimPrefix}:${source}`;
  if (!await callbacks.claim(claimSource)) {
    return { recovered: false, outcome: 'claim_denied' };
  }

  callbacks.prepare();
  try {
    await callbacks.execute(claimSource);
    const retrySettled = await callbacks.settleRetries();
    const recovered = retrySettled && callbacks.hasDurableAssistant();
    if (recovered) {
      await callbacks.complete();
      return { recovered: true, outcome: 'completed' };
    }
    const error = callbacks.noResultError();
    await callbacks.release(error);
    return { recovered: false, outcome: 'no_result', error };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error || failureMessage);
    callbacks.log(message);
    if (callbacks.isTransient(message)) {
      callbacks.surfaceTransient(`${failurePrefix}:${source}`, message);
      await callbacks.release(message);
      return { recovered: false, outcome: 'transient_failure', error: message };
    }
    if (callbacks.isUnavailable(message)) {
      await callbacks.settleUnavailable(message);
      callbacks.emitFailure(message);
      return { recovered: false, outcome: 'unavailable', error: message };
    }
    await callbacks.release(message);
    callbacks.emitFailure(message);
    return { recovered: false, outcome: 'failed', error: message };
  }
}
