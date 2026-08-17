import { describe, expect, it, vi } from 'vitest';
import {
  analyzePiAgentEndError,
  getCodexFallbackModelSpecs,
  isCodexAuthInvalidatedError,
  isCodexUsageLimitError,
} from '../pi/agent-end-policy.js';

describe('Pi agent_end policy', () => {
  it('detects Codex usage limit and auth invalidation strings', () => {
    expect(isCodexUsageLimitError('usage_limit_reached')).toBe(true);
    expect(isCodexUsageLimitError('X-Codex-Active-Limit')).toBe(true);
    expect(isCodexAuthInvalidatedError('authentication token has been invalidated')).toBe(true);
    expect(isCodexAuthInvalidatedError('please try signing in again')).toBe(true);
  });

  it('resolves Codex fallback specs from env-style comma list or default', () => {
    expect(getCodexFallbackModelSpecs('litellm/a, openrouter/b ,,')).toEqual(['litellm/a', 'openrouter/b']);
    expect(getCodexFallbackModelSpecs('')).toEqual(['azure-openai-responses-eastus2/gpt-5.5']);
  });

  it('returns null when there is no assistant error', () => {
    expect(analyzePiAgentEndError({
      messages: [{ role: 'user', content: [] }, { role: 'assistant', stopReason: 'stop' }],
      provider: 'openrouter',
      isCodexUsageLimitError: () => false,
      isCodexAuthInvalidatedError: () => false,
      isPiTransientAbortError: () => false,
      canAutoRetryTransientAbort: () => true,
    })).toBeNull();
  });

  it('classifies codex usage limit before transient retry', () => {
    const result = analyzePiAgentEndError({
      messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'usage_limit_reached' }],
      provider: 'openai-codex',
      isCodexUsageLimitError: (msg) => String(msg).includes('usage_limit'),
      isCodexAuthInvalidatedError: () => false,
      isPiTransientAbortError: () => true,
      canAutoRetryTransientAbort: () => true,
    });

    expect(result).toMatchObject({
      carriedError: true,
      fullErrText: 'usage_limit_reached',
      isCodexUsageLimit: true,
      isCodexAuthInvalid: false,
      isTransientAbort: false,
      shouldAutoRetryTransient: false,
    });
  });

  it('classifies codex auth invalidation as codex fallback trigger', () => {
    const result = analyzePiAgentEndError({
      messages: [{ role: 'assistant', errorMessage: 'authentication token has been invalidated' }],
      provider: 'openai-codex',
      isCodexUsageLimitError: () => false,
      isCodexAuthInvalidatedError: (msg) => String(msg).includes('invalidated'),
      isPiTransientAbortError: () => true,
      canAutoRetryTransientAbort: () => true,
    });

    expect(result?.isCodexAuthInvalid).toBe(true);
    expect(result?.isTransientAbort).toBe(false);
  });

  it('classifies transient abort and respects retry predicate', () => {
    const canRetry = vi.fn(() => true);
    const result = analyzePiAgentEndError({
      messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'This operation was aborted' }],
      provider: 'litellm',
      isCodexUsageLimitError: () => false,
      isCodexAuthInvalidatedError: () => false,
      isPiTransientAbortError: (msg) => String(msg).includes('aborted'),
      canAutoRetryTransientAbort: canRetry,
    });

    expect(result?.isTransientAbort).toBe(true);
    expect(result?.shouldAutoRetryTransient).toBe(true);
    expect(canRetry).toHaveBeenCalledTimes(1);
  });

  it('truncates errText for user-facing messages', () => {
    const long = 'x'.repeat(700);
    const result = analyzePiAgentEndError({
      messages: [{ role: 'assistant', errorMessage: long }],
      provider: 'openrouter',
      isCodexUsageLimitError: () => false,
      isCodexAuthInvalidatedError: () => false,
      isPiTransientAbortError: () => false,
      canAutoRetryTransientAbort: () => false,
    });

    expect(result?.errText).toHaveLength(500);
  });
});
