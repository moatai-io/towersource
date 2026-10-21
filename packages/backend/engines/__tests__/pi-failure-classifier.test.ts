import { describe, expect, it } from 'vitest';
import {
  PI_MODEL_ACCOUNT_STATUS_USER_NOTICE,
  PI_TOWER_PREFLIGHT_FAILURE_NOTICE,
  PI_PROVIDER_BUDGET_USER_NOTICE,
  classifyPiFailure,
  formatPiProviderErrorForOperatorLog,
  formatPiProviderErrorForUser,
  isPiAuthFailure,
  isPiCapacityThrottleFailure,
  isPiContextOverflowFailure,
  isPiModelAccountStatusFailure,
  isPiQuotaFailure,
  isPiRequestTooLargeFailure,
  isPiTowerRequestPreflight,
  isPiTransientTransportFailure,
  isPiUserAbortError,
} from '../pi-failure-classifier.js';

describe('Pi failure classifier', () => {
  it('does not disguise a provider usage-shape exception as a retryable HTTP failure', () => {
    const message = "API Error (503): AttributeError: 'dict' object has no attribute 'usage'";
    expect(classifyPiFailure(message)).toMatchObject({ kind: 'provider_response_schema', visible: true, retryableBeforeSideEffects: true, recoverable: true });
    expect(isPiTransientTransportFailure(message)).toBe(false);
    expect(formatPiProviderErrorForUser(message)).toContain('응답 형식 처리 오류');
    expect(formatPiProviderErrorForUser(message)).not.toContain('연결이 반복해서');
  });
  it('classifies transient transport drops as quiet aborted failures', () => {
    const samples = [
      'Request was aborted',
      'Request timed out.',
      'stream_incomplete: Upstream websocket closed before response.completed: no close frame received or sent',
      'upstream_stream_truncated: Responses stream ended before a terminal event',
      'OpenAI Responses stream ended before a terminal response event',
      'socket hang up ECONNRESET',
      'Connection error.',
      'Network error.',
      "OpenAI API error (500): 500 litellm.InternalServerError: InternalServerError: OpenAIException - Cannot connect to host codex-lb:2455 ssl:<ssl.SSLContext object> [Connect call failed ('172.18.0.3', 2455)]. Received Model Group=smartest",
      'litellm-responses API error (502): 502 <html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1></body></html>',
      'litellm-responses API error (503): upstream temporarily unavailable',
      'HTTP 504 Gateway Timeout',
    ];

    for (const sample of samples) {
      expect(isPiTransientTransportFailure(sample)).toBe(true);
      expect(classifyPiFailure(sample)).toMatchObject({
        kind: 'transient_transport',
        visible: false,
        stop: 'aborted',
        retryableBeforeSideEffects: true,
      });
    }
  });

  it('keeps auth and user abort out of transient transport retry policy', () => {
    expect(isPiAuthFailure('invalidated oauth token')).toBe(true);
    expect(isPiTransientTransportFailure('invalidated oauth token')).toBe(false);
    expect(classifyPiFailure('invalidated oauth token')).toMatchObject({
      kind: 'provider_auth',
      visible: true,
      stop: 'error',
      retryableBeforeSideEffects: false,
    });
    expect(formatPiProviderErrorForUser('Your authentication token has been invalidated. Please try signing in again.')).toBe(PI_MODEL_ACCOUNT_STATUS_USER_NOTICE);
    expect(formatPiProviderErrorForOperatorLog('token_invalidated')).toBe('model_account_status_issue');

    expect(isPiUserAbortError('BadRequestError: request aborted by user')).toBe(true);
    expect(isPiTransientTransportFailure('BadRequestError: request aborted by user')).toBe(false);
    expect(classifyPiFailure('BadRequestError: request aborted by user')).toMatchObject({
      kind: 'user_abort',
      visible: false,
      stop: 'aborted',
    });
  });

  it('classifies provider capacity/server overload as quiet retryable provider capacity', () => {
    const samples = [
      'No available accounts. Service is operating in degraded mode: all upstream accounts are unavailable code=account_stream_cap',
      'server_is_overloaded: Our servers are currently overloaded. Please try again later.',
      'OpenAI API error (500): server_error: An error occurred while processing your request.',
    ];

    for (const sample of samples) {
      expect(isPiCapacityThrottleFailure(sample)).toBe(true);
      expect(isPiQuotaFailure(sample)).toBe(false);
      expect(classifyPiFailure(sample)).toMatchObject({
        kind: 'provider_capacity',
        visible: false,
        stop: 'aborted',
        retryableBeforeSideEffects: true,
      });
    }
  });

  it('routes HTTP 413 payload rejection to bounded size recovery, not transient retries', () => {
    const error = 'litellm-responses API error (413): 413 <html><h1>413 Request Entity Too Large</h1></html>';
    expect(isPiRequestTooLargeFailure(error)).toBe(true);
    expect(isPiTransientTransportFailure(error)).toBe(false);
    expect(classifyPiFailure(error)).toMatchObject({
      kind: 'provider_request_too_large', visible: true, stop: 'error', retryableBeforeSideEffects: false,
    });
    expect(formatPiProviderErrorForUser(error)).toContain('요청 본문');
    expect(classifyPiFailure('tower_transport_budget_exceeded')).toMatchObject({ kind: 'provider_request_too_large', recoverable: false });
    expect(formatPiProviderErrorForUser(error)).not.toContain('<html>');
  });

  it('distinguishes Tower synthetic preflight from real provider overflow in user-facing errors', () => {
    const synthetic = 'litellm-responses API error (400): {"message":"context_length_exceeded: Pi Responses preflight rejected near-context request before upstream send (bodyEstimatedPromptTokens=363505 >= preflightFloor=360000 (ratio=0.9, context=400000))"}';
    expect(isPiTowerRequestPreflight(synthetic)).toBe(true);
    expect(classifyPiFailure(synthetic)).toMatchObject({ kind: 'tower_request_preflight', visible: false });
    expect(formatPiProviderErrorForUser(synthetic)).toBe(PI_TOWER_PREFLIGHT_FAILURE_NOTICE);
    expect(formatPiProviderErrorForUser(synthetic)).not.toContain('litellm-responses API error');
    expect(formatPiProviderErrorForUser(synthetic)).not.toContain('363505');
    const upstream = 'litellm-responses API error (400): context_length_exceeded: maximum context length exceeded';
    expect(isPiTowerRequestPreflight(upstream)).toBe(false);
    expect(classifyPiFailure(upstream).kind).toBe('provider_context_overflow');
    expect(formatPiProviderErrorForUser(upstream)).toContain('모델 제공자가');
    expect(formatPiProviderErrorForUser(upstream)).not.toContain('litellm-responses API error');
  });

  it('classifies context overflow and quota as visible recoverable provider errors', () => {
    expect(isPiContextOverflowFailure('context_length_exceeded: input exceeds the context window')).toBe(true);
    expect(classifyPiFailure('context_length_exceeded: input exceeds the context window')).toMatchObject({
      kind: 'provider_context_overflow',
      visible: true,
      stop: 'error',
    });

    expect(isPiQuotaFailure('usage_limit_reached: X-Codex-Plan-Type')).toBe(true);
    expect(classifyPiFailure('usage_limit_reached: X-Codex-Plan-Type')).toMatchObject({
      kind: 'provider_quota',
      visible: true,
      stop: 'error',
    });
    expect(isPiModelAccountStatusFailure('usage_limit_reached: The usage limit has been reached')).toBe(true);
    expect(formatPiProviderErrorForUser('usage_limit_reached: The usage limit has been reached')).toBe(PI_MODEL_ACCOUNT_STATUS_USER_NOTICE);
    expect(formatPiProviderErrorForOperatorLog('usage_limit_reached: The usage limit has been reached')).toBe('model_account_status_issue');

    const budgetExceeded = 'OpenAI API error (400): 400 Budget has been exceeded! Team=team-id Current cost: 4000.692308649989, Max budget: 4000.0';
    expect(isPiQuotaFailure(budgetExceeded)).toBe(true);
    expect(classifyPiFailure(budgetExceeded)).toMatchObject({
      kind: 'provider_quota',
      visible: true,
      stop: 'error',
    });
    expect(formatPiProviderErrorForUser(budgetExceeded)).toBe(PI_PROVIDER_BUDGET_USER_NOTICE);
    expect(formatPiProviderErrorForUser(budgetExceeded)).not.toContain('$4,000.69');
  });

  it('defaults unknown failures to visible unknown_fatal', () => {
    expect(classifyPiFailure('some new provider failure')).toMatchObject({
      kind: 'unknown_fatal',
      visible: true,
      stop: 'error',
      retryableBeforeSideEffects: false,
    });
  });
});
