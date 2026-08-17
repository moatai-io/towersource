// Owns pure turn metrics/failure calculations for Pi run loop.
// Public API: classifyPiRunEndFailure, chooseContextRiskEstimateTokens, normalizeIterationCount.

import type { PiFailureClass } from '../pi-failure-classifier.js';
import type { StuckReason } from '../pi-stream-watchdog.js';

export type PiRunEndTerminalizerReason =
  | 'watchdog_stuck'
  | 'transient_transport'
  | 'sdk_zombie'
  | 'unknown_fatal'
  | 'unknown_terminalizer';

export interface PiRunEndFailureDetails {
  failure?: PiFailureClass;
  terminalizerReason?: PiRunEndTerminalizerReason;
  providerErrorMessage?: string;
}

export function classifyPiRunEndFailure(params: {
  watchdogAborted: StuckReason | null;
  transientAbortVisibleSuppressed: boolean;
  terminalForced: boolean;
  terminalizerReason?: PiRunEndTerminalizerReason;
  providerErrorMessage?: string;
  errorStopReason?: 'error' | 'aborted';
}): PiFailureClass | undefined {
  if (params.watchdogAborted) return 'watchdog_stuck';
  if (params.transientAbortVisibleSuppressed) return 'transient_transport';
  if (params.providerErrorMessage && params.errorStopReason === 'error') return 'unknown_fatal';
  if (params.terminalizerReason === 'watchdog_stuck') return 'watchdog_stuck';
  if (params.terminalizerReason === 'transient_transport') return 'transient_transport';
  if (params.terminalizerReason === 'sdk_zombie') return 'sdk_zombie';
  if (params.terminalizerReason === 'unknown_fatal') return 'unknown_fatal';
  if (params.terminalizerReason === 'unknown_terminalizer') return undefined;
  if (params.terminalForced) return 'sdk_zombie';
  if (params.errorStopReason === 'error') return 'unknown_fatal';
  return undefined;
}

export function chooseContextRiskEstimateTokens(params: {
  compactionSucceededThisTurn: boolean;
  estimatedLiveContextInput: number;
  actualContextInput: number;
}): number {
  if (params.compactionSucceededThisTurn && params.estimatedLiveContextInput > 0) {
    return params.estimatedLiveContextInput;
  }
  return Math.max(params.actualContextInput, params.estimatedLiveContextInput);
}

export function normalizeIterationCount(iterationCount: number): number {
  return Math.max(iterationCount, 1);
}
