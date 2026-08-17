import { describe, expect, it, vi } from 'vitest';
import {
  runPiContinuationRecovery,
  settlePiRecoveryOutcome,
  type PiContinuationRecoveryCallbacks,
  type PiRecoverySettlementCallbacks,
} from './recovery-coordinator.js';

function callbacks(overrides: Partial<PiContinuationRecoveryCallbacks> = {}): PiContinuationRecoveryCallbacks {
  return {
    claim: vi.fn().mockResolvedValue(true),
    prepare: vi.fn(),
    execute: vi.fn().mockResolvedValue(undefined),
    settleRetries: vi.fn().mockResolvedValue(true),
    hasDurableAssistant: vi.fn().mockReturnValue(true),
    noResultError: vi.fn().mockReturnValue('Recovery produced no durable assistant result.'),
    complete: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    settleUnavailable: vi.fn().mockResolvedValue(undefined),
    surfaceTransient: vi.fn(),
    emitFailure: vi.fn(),
    isTransient: vi.fn().mockReturnValue(false),
    isUnavailable: vi.fn().mockReturnValue(false),
    log: vi.fn(),
    ...overrides,
  };
}

function settlementCallbacks(overrides: Partial<PiRecoverySettlementCallbacks> = {}): PiRecoverySettlementCallbacks {
  return {
    complete: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    isUnavailable: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

describe('Pi recovery coordinator', () => {
  it('claims, continues, and completes a durable recovery', async () => {
    const cb = callbacks();
    const result = await runPiContinuationRecovery({
      trigger: 'transient', source: 'prompt-rejected', failureMessage: 'failed', callbacks: cb,
    });

    expect(result).toEqual({ recovered: true, outcome: 'completed' });
    expect(cb.claim).toHaveBeenCalledWith('transient:prompt-rejected');
    expect(cb.prepare).toHaveBeenCalledOnce();
    expect(cb.execute).toHaveBeenCalledWith('transient:prompt-rejected');
    expect(cb.complete).toHaveBeenCalledOnce();
    expect(cb.release).not.toHaveBeenCalled();
  });

  it('releases transient failures without emitting generic continuation failure', async () => {
    const error = new Error('connection reset');
    const cb = callbacks({
      execute: vi.fn().mockRejectedValue(error),
      isTransient: vi.fn().mockReturnValue(true),
    });
    const result = await runPiContinuationRecovery({
      trigger: 'post_compact', source: 'overflow', failureMessage: 'failed', callbacks: cb,
    });

    expect(result.outcome).toBe('transient_failure');
    expect(cb.surfaceTransient).toHaveBeenCalledWith('post-compact-continuation:overflow', error.message);
    expect(cb.release).toHaveBeenCalledWith(error.message);
    expect(cb.emitFailure).not.toHaveBeenCalled();
  });

  it('settles unavailable continuation as uncertain and emits recoverable failure', async () => {
    const error = new Error('native unavailable');
    const cb = callbacks({
      execute: vi.fn().mockRejectedValue(error),
      isUnavailable: vi.fn().mockReturnValue(true),
    });
    const result = await runPiContinuationRecovery({
      trigger: 'incomplete', source: 'resolved', failureMessage: 'failed', callbacks: cb,
    });

    expect(result.outcome).toBe('unavailable');
    expect(cb.settleUnavailable).toHaveBeenCalledWith(error.message);
    expect(cb.emitFailure).toHaveBeenCalledWith(error.message);
    expect(cb.release).not.toHaveBeenCalled();
  });

  it('completes a restart recovery only with a durable stopped assistant result', async () => {
    const cb = settlementCallbacks();
    const result = await settlePiRecoveryOutcome({
      aborted: false,
      durableAssistant: true,
      stopReason: 'stop',
      noResultError: 'no result',
      callbacks: cb,
    });

    expect(result).toEqual({ outcome: 'completed' });
    expect(cb.complete).toHaveBeenCalledWith('completed');
    expect(cb.release).not.toHaveBeenCalled();
  });

  it('settles user abort as failed and native unavailable as uncertain', async () => {
    const abortCb = settlementCallbacks();
    const aborted = await settlePiRecoveryOutcome({
      executionError: 'cancelled',
      aborted: true,
      durableAssistant: false,
      noResultError: 'no result',
      callbacks: abortCb,
    });
    expect(aborted.outcome).toBe('failed');
    expect(abortCb.complete).toHaveBeenCalledWith('failed', 'cancelled');

    const unavailableCb = settlementCallbacks({ isUnavailable: vi.fn().mockReturnValue(true) });
    const unavailable = await settlePiRecoveryOutcome({
      executionError: 'native unavailable',
      aborted: false,
      durableAssistant: false,
      noResultError: 'no result',
      callbacks: unavailableCb,
    });
    expect(unavailable.outcome).toBe('failed');
    expect(unavailableCb.complete).toHaveBeenCalledWith('uncertain', 'native unavailable');
    expect(unavailableCb.release).not.toHaveBeenCalled();
  });

  it('releases restart recovery without a durable result as retryable', async () => {
    const cb = settlementCallbacks();
    const result = await settlePiRecoveryOutcome({
      aborted: false,
      durableAssistant: false,
      stopReason: 'error',
      noResultError: 'recovery produced no result',
      callbacks: cb,
    });

    expect(result).toEqual({ outcome: 'retryable_failure', error: 'recovery produced no result' });
    expect(cb.release).toHaveBeenCalledWith('recovery produced no result');
    expect(cb.complete).not.toHaveBeenCalled();
  });
});
