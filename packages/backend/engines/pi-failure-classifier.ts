/**
 * Owns: Pi provider/SDK failure classification policy.
 * Public API: classifyPiFailure plus small predicate helpers for legacy call sites.
 *
 * Phase 2 moves scattered regex checks toward a single policy table: what is
 * visible to users, what closes quietly, and what is safe to retry before any
 * side effects. Keep this module pure so source-contract tests do not need a Pi
 * SDK session.
 */

export type PiFailureClass =
  | 'transient_transport'
  | 'provider_capacity'
  | 'provider_context_overflow'
  | 'provider_auth'
  | 'provider_quota'
  | 'user_abort'
  | 'watchdog_stuck'
  | 'sdk_zombie'
  | 'tool_error'
  | 'unknown_fatal';

export interface PiFailureClassification {
  kind: PiFailureClass;
  visible: boolean;
  stop: 'complete' | 'aborted' | 'error';
  retryableBeforeSideEffects: boolean;
  recoverable: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface PiProviderBudgetErrorDetails {
  currentCost?: number;
  maxBudget?: number;
}

export const PI_MODEL_ACCOUNT_STATUS_USER_NOTICE = '현재 모델 계정 인증/사용량 상태 문제입니다. 금방 해결할테니 잠시 후 다시 시도해주세요.';

export function isPiUserAbortError(message: unknown): boolean {
  const text = String(message || '');
  return /badrequesterror:\s*request aborted|user abort|user cancelled|user canceled/i.test(text);
}

export function isPiAuthFailure(message: unknown): boolean {
  const text = String(message || '');
  return /invalidated oauth|authentication token|please.*signing in|reauth_required|token_revoked|token_invalidated/i.test(text);
}

export function isPiModelAccountStatusFailure(message: unknown): boolean {
  const text = String(message || '');
  return isPiAuthFailure(text) || /usage_limit_reached|usage limit has been reached|X-Codex-Plan-Type|X-Codex-Active-Limit/i.test(text);
}

export function isPiContextOverflowFailure(message: unknown): boolean {
  const text = String(message || '');
  return /context_length_exceeded|context window|input exceeds the context|maximum context length|too many tokens/i.test(text);
}

export function isPiCapacityThrottleFailure(message: unknown): boolean {
  const text = String(message || '');
  return /account_stream_cap|No available accounts|all upstream accounts are unavailable|Service is operating in degraded mode|server_is_overloaded|servers are currently overloaded|\bserver_error\b|an error occurred while processing your request/i.test(text);
}

export function isPiProviderBudgetExceededFailure(message: unknown): boolean {
  const text = String(message || '');
  return /Budget has been exceeded|Max budget|Current cost/i.test(text);
}

export function parsePiProviderBudgetError(message: unknown): PiProviderBudgetErrorDetails | null {
  const text = String(message || '');
  if (!isPiProviderBudgetExceededFailure(text)) return null;
  const current = /Current cost:\s*([0-9]+(?:\.[0-9]+)?)/i.exec(text);
  const max = /Max budget:\s*([0-9]+(?:\.[0-9]+)?)/i.exec(text);
  return {
    currentCost: current ? Number(current[1]) : undefined,
    maxBudget: max ? Number(max[1]) : undefined,
  };
}

export function formatPiProviderErrorForUser(message: unknown): string {
  const text = String(message || 'Unknown provider error').trim();
  const budget = parsePiProviderBudgetError(text);
  if (budget) {
    const current = typeof budget.currentCost === 'number' && Number.isFinite(budget.currentCost)
      ? `$${budget.currentCost.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
      : '현재 사용액 확인 불가';
    const max = typeof budget.maxBudget === 'number' && Number.isFinite(budget.maxBudget)
      ? `$${budget.maxBudget.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
      : '한도 확인 불가';
    return [
      'LiteLLM 예산 한도에 도달해서 모델 호출이 차단되었습니다.',
      `현재 사용액: ${current} / 한도: ${max}`,
      '예산을 올렸다면 LiteLLM의 해당 팀 예산이 실제 운영 DB/캐시에 반영됐는지 확인한 뒤 다시 시도하세요.',
    ].join('\n');
  }
  if (isPiModelAccountStatusFailure(text)) {
    return PI_MODEL_ACCOUNT_STATUS_USER_NOTICE;
  }
  return text.slice(0, 500);
}

export function formatPiProviderErrorForOperatorLog(message: unknown): string {
  const text = String(message || 'Unknown provider error').trim();
  if (isPiModelAccountStatusFailure(text)) return 'model_account_status_issue';
  if (isPiProviderBudgetExceededFailure(text)) return 'litellm_budget_exceeded';
  return 'provider_error';
}

export function isPiQuotaFailure(message: unknown): boolean {
  const text = String(message || '');
  if (isPiCapacityThrottleFailure(text)) return false;
  return /usage_limit_reached|usage limit has been reached|rate limit|quota|insufficient_quota|Budget has been exceeded|Max budget|Current cost|X-Codex-Plan-Type|X-Codex-Active-Limit/i.test(text);
}

export function isPiTransientTransportFailure(message: unknown): boolean {
  const text = String(message || '');
  if (!text || isPiAuthFailure(text) || isPiUserAbortError(text)) return false;
  return /^(connection error\.?|network error\.?|request timed out\.?)$/i.test(text.trim()) ||
    /upstream_unavailable|request (?:to upstream )?timed out|request was aborted|this operation was aborted|codex sse .*terminated|sse .*terminated|\bterminated\b|fetch aborted|network.*abort|socket hang up|econnreset|connectionrefused|connect call failed|cannot connect to host|clientconnectorerror|stream_incomplete|upstream_stream_truncated|responses stream ended before a terminal (?:response )?event|upstream websocket closed|before response\.completed|no close frame/i.test(text);
}

export function classifyPiFailure(message: unknown): PiFailureClassification {
  if (isPiUserAbortError(message)) {
    return {
      kind: 'user_abort',
      visible: false,
      stop: 'aborted',
      retryableBeforeSideEffects: false,
      recoverable: true,
      logLevel: 'info',
    };
  }

  if (isPiAuthFailure(message)) {
    return {
      kind: 'provider_auth',
      visible: true,
      stop: 'error',
      retryableBeforeSideEffects: false,
      recoverable: true,
      logLevel: 'warn',
    };
  }

  if (isPiCapacityThrottleFailure(message)) {
    return {
      kind: 'provider_capacity',
      visible: false,
      stop: 'aborted',
      retryableBeforeSideEffects: true,
      recoverable: true,
      logLevel: 'warn',
    };
  }

  if (isPiQuotaFailure(message)) {
    return {
      kind: 'provider_quota',
      visible: true,
      stop: 'error',
      retryableBeforeSideEffects: false,
      recoverable: true,
      logLevel: 'warn',
    };
  }

  if (isPiContextOverflowFailure(message)) {
    return {
      kind: 'provider_context_overflow',
      visible: true,
      stop: 'error',
      retryableBeforeSideEffects: false,
      recoverable: true,
      logLevel: 'warn',
    };
  }

  if (isPiTransientTransportFailure(message)) {
    return {
      kind: 'transient_transport',
      visible: false,
      stop: 'aborted',
      retryableBeforeSideEffects: true,
      recoverable: true,
      logLevel: 'warn',
    };
  }

  return {
    kind: 'unknown_fatal',
    visible: true,
    stop: 'error',
    retryableBeforeSideEffects: false,
    recoverable: true,
    logLevel: 'error',
  };
}
