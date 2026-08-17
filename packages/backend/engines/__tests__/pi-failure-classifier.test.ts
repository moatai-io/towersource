import { describe, expect, it } from 'vitest';
import {
  PI_MODEL_ACCOUNT_STATUS_USER_NOTICE,
  classifyPiFailure,
  formatPiProviderErrorForOperatorLog,
  formatPiProviderErrorForUser,
  isPiAuthFailure,
  isPiCapacityThrottleFailure,
  isPiContextOverflowFailure,
  isPiModelAccountStatusFailure,
  isPiQuotaFailure,
  isPiTransientTransportFailure,
  isPiUserAbortError,
} from '../pi-failure-classifier.js';

describe('Pi failure classifier', () => {
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
    expect(formatPiProviderErrorForUser(budgetExceeded)).toContain('LiteLLM 예산 한도에 도달');
    expect(formatPiProviderErrorForUser(budgetExceeded)).toContain('$4,000.69 / 한도: $4,000');
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
