// Owns small Pi run-loop policy helpers: watchdog wording and transient retry backoff.
// Public API: formatWatchdogReason, transient retry constants/helpers.

import type { StuckReason } from '../pi-stream-watchdog.js';
import { classifyPiFailure, isPiCapacityThrottleFailure, isPiTransientTransportFailure } from '../pi-failure-classifier.js';

/**
 * Korean-facing watchdog abort reason — fed into engine_error message so the
 * user sees *why* the turn ended, not a generic "aborted".
 */
export function formatWatchdogReason(reason: StuckReason, streamIdleMs: number, blockTimeoutMs: number): string {
  const blockSecs = Math.round(blockTimeoutMs / 1000);
  switch (reason) {
    case 'idle':
      return `스트림 무응답 ${Math.round(streamIdleMs / 1000)}초 — 모델/네트워크 문제로 자동 종료`;
    case 'thinking-stuck':
      return `Thinking 단계가 ${blockSecs}초 동안 종료 신호 없음 — pi-coding-agent #2381 패턴 (모델/SDK hang) 으로 자동 종료`;
    case 'text-stuck':
      return `Text 응답이 ${blockSecs}초 동안 종료 신호 없음 — pi-coding-agent #2381 패턴 으로 자동 종료`;
    case 'toolcall-stuck':
      return `Tool call 생성이 ${blockSecs}초 동안 종료 신호 없음 — pi-coding-agent #2381 패턴 으로 자동 종료`;
  }
}

export const TRANSIENT_ABORT_RETRY_MAX = Number(process.env.PI_TRANSIENT_ABORT_RETRY_MAX || 2);
const TRANSIENT_ABORT_RETRY_BACKOFF_MS = [1_000, 3_000];
const PROVIDER_CAPACITY_RETRY_BACKOFF_MS = [30_000, 90_000];
const ROUTER_RESTART_RETRY_BACKOFF_MS = Number(process.env.PI_ROUTER_RESTART_RETRY_BACKOFF_MS || 60_000);

function isGenericConnectionDrop(message: unknown): boolean {
  const text = String(message || '').trim();
  return /^(connection error\.?|network error\.?)$/i.test(text) ||
    /cannot connect to host|connect call failed|connectionrefused|clientconnectorerror/i.test(text);
}

export function getTransientAbortRetryMax(message: unknown): number {
  if (isGenericConnectionDrop(message)) return 0;
  if (isPiCapacityThrottleFailure(message)) return Math.min(TRANSIENT_ABORT_RETRY_MAX, 2);
  return TRANSIENT_ABORT_RETRY_MAX;
}

export function getTransientAbortRetryDelayMs(message: unknown, attempt: number): number {
  if (isGenericConnectionDrop(message)) return ROUTER_RESTART_RETRY_BACKOFF_MS;
  if (isPiCapacityThrottleFailure(message)) {
    return PROVIDER_CAPACITY_RETRY_BACKOFF_MS[Math.min(attempt - 1, PROVIDER_CAPACITY_RETRY_BACKOFF_MS.length - 1)] || 90_000;
  }
  return TRANSIENT_ABORT_RETRY_BACKOFF_MS[Math.min(attempt - 1, TRANSIENT_ABORT_RETRY_BACKOFF_MS.length - 1)] || 3_000;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isPiTransientAbortError(message: unknown): boolean {
  const kind = classifyPiFailure(message).kind;
  if (kind === 'provider_capacity') return true;
  return kind === 'transient_transport' && isPiTransientTransportFailure(message);
}
