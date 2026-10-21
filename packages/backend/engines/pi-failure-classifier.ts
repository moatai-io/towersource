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
  | 'provider_response_schema'
  | 'provider_capacity'
  | 'provider_context_overflow'
  | 'tower_request_preflight'
  | 'provider_request_too_large'
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
export const PI_PROVIDER_BUDGET_USER_NOTICE = '월간 사용량 한도액에 달했습니다. 운영자에게 문의하세요.';

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

// The transport uses a synthetic 400 to let Pi's native overflow recovery run.
// This is Tower's own admission signal, not an upstream/provider response.
export function isPiTowerRequestPreflight(message: unknown): boolean {
  return /Pi Responses preflight rejected near-context request before upstream send/i.test(String(message || ''));
}

export const PI_TOWER_PREFLIGHT_FAILURE_NOTICE =
  '요청 크기 추정치가 안전 기준을 넘어 컨텍스트 정리를 시도했지만, 이번 실행을 복구하지 못했습니다. 실제 모델의 토큰 한도 초과가 확인된 것은 아닙니다. 진행된 도구 작업을 확인한 뒤 입력·첨부를 줄여 후속 요청을 보내주세요.';

/** Payload byte limits are distinct from token context limits. */
export function isPiRequestTooLargeFailure(message: unknown): boolean {
  return /tower_transport_budget_exceeded|request_body_budget_exceeded|request_too_large|request entity too large|payload too large|API error \(413\)|HTTP\s+413/i.test(String(message || ''));
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
  if (isPiProviderResponseSchemaFailure(text)) return '모델 제공 경로에서 응답 형식 처리 오류가 발생했습니다. 네트워크 끊김과는 다른 오류입니다. 진행된 작업을 확인한 뒤 다시 요청해 주세요. 반복되면 운영자가 제공자 오류 기록을 확인해야 합니다.';
  if (isPiTowerRequestPreflight(text)) return PI_TOWER_PREFLIGHT_FAILURE_NOTICE;
  if (isPiRequestTooLargeFailure(text)) return '요청 본문이 제공자 또는 프록시의 전송 크기 제한을 넘었습니다. 이미지·페이지 묶음과 입력 크기를 줄여야 합니다. 대화 압축은 이 전송 오류의 자동 복구 방법이 아니며, 같은 요청을 그대로 반복하지 마세요.';
  if (isPiContextOverflowFailure(text)) return '모델 제공자가 컨텍스트 한도 초과로 요청을 거절했습니다. 자동 정리로 복구하지 못했다면 진행된 작업을 확인한 뒤 입력·첨부를 줄여 이어가 주세요.';
  const budget = parsePiProviderBudgetError(text);
  if (budget) return PI_PROVIDER_BUDGET_USER_NOTICE;
  if (isPiModelAccountStatusFailure(text)) {
    return PI_MODEL_ACCOUNT_STATUS_USER_NOTICE;
  }
  return text.slice(0, 500);
}

export function formatPiProviderErrorForOperatorLog(message: unknown): string {
  const text = String(message || 'Unknown provider error').trim();
  if (isPiTowerRequestPreflight(text)) return 'tower_request_preflight';
  if (isPiModelAccountStatusFailure(text)) return 'model_account_status_issue';
  if (isPiProviderBudgetExceededFailure(text)) return 'litellm_budget_exceeded';
  return 'provider_error';
}

export function isPiQuotaFailure(message: unknown): boolean {
  const text = String(message || '');
  if (isPiCapacityThrottleFailure(text)) return false;
  return /usage_limit_reached|usage limit has been reached|rate limit|quota|insufficient_quota|Budget has been exceeded|Max budget|Current cost|X-Codex-Plan-Type|X-Codex-Active-Limit/i.test(text);
}

// Python adapter error returned by the provider/proxy, not a socket failure.
// Keep the distinct cause even when bounded run-loop recovery retries it.
export function isPiProviderResponseSchemaFailure(message: unknown): boolean {
  return /['"]dict['"] object has no attribute ['"]usage['"]/i.test(String(message || ''));
}

export function isPiTransientTransportFailure(message: unknown): boolean {
  const text = String(message || '');
  if (!text || isPiAuthFailure(text) || isPiUserAbortError(text) || isPiProviderResponseSchemaFailure(text)) return false;
  return /^(connection error\.?|network error\.?|request timed out\.?)$/i.test(text.trim()) ||
    /upstream_unavailable|request (?:to upstream )?timed out|request was aborted|this operation was aborted|codex sse .*terminated|sse .*terminated|\bterminated\b|fetch aborted|network.*abort|socket hang up|econnreset|connectionrefused|connect call failed|cannot connect to host|clientconnectorerror|stream_incomplete|upstream_stream_truncated|responses stream ended before a terminal (?:response )?event|upstream websocket closed|before response\.completed|no close frame/i.test(text) ||
    /(?:api error\s*\(|http(?: status)?\s+)(?:502|503|504)\b/i.test(text) ||
    /\b(?:502 bad gateway|503 service unavailable|504 gateway timeout)\b/i.test(text);
}

export function classifyPiFailure(message: unknown): PiFailureClassification {
  if (isPiProviderResponseSchemaFailure(message)) {
    return { kind: 'provider_response_schema', visible: true, stop: 'error', retryableBeforeSideEffects: true, recoverable: true, logLevel: 'error' };
  }

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

  if (isPiTowerRequestPreflight(message)) {
    return { kind: 'tower_request_preflight', visible: false, stop: 'error',
      retryableBeforeSideEffects: false, recoverable: true, logLevel: 'info' };
  }

  if (isPiRequestTooLargeFailure(message)) {
    return { kind: 'provider_request_too_large', visible: true, stop: 'error',
      retryableBeforeSideEffects: false, recoverable: false, logLevel: 'warn' };
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
