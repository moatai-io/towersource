// Owns pure classification of Pi agent_end catch-path errors.
// Public API: analyzePiAgentEndError.

export interface PiAgentEndAnalysis {
  carriedError: boolean;
  fullErrText: string;
  errText: string;
  stopReason?: string;
  isCodexUsageLimit: boolean;
  isCodexAuthInvalid: boolean;
  isTransientAbort: boolean;
  shouldAutoRetryTransient: boolean;
}

export function isCodexUsageLimitError(message: unknown): boolean {
  const text = String(message || '');
  return /usage_limit_reached|usage limit has been reached|X-Codex-Plan-Type|X-Codex-Active-Limit/i.test(text);
}

export function isCodexAuthInvalidatedError(message: unknown): boolean {
  const text = String(message || '');
  return /invalidated oauth token|authentication token has been invalidated|please try signing in again/i.test(text);
}

export function getCodexFallbackModelSpecs(envValue = process.env.PI_CODEX_FALLBACK_MODELS): string[] {
  if (envValue && envValue.trim()) {
    return envValue.split(',').map(s => s.trim()).filter(Boolean);
  }
  return ['azure-openai-responses-eastus2/gpt-5.5'];
}

export function analyzePiAgentEndError(params: {
  messages: any[];
  provider?: string;
  isCodexUsageLimitError: (message: unknown) => boolean;
  isCodexAuthInvalidatedError: (message: unknown) => boolean;
  isPiTransientAbortError: (message: unknown) => boolean;
  canAutoRetryTransientAbort: () => boolean;
}): PiAgentEndAnalysis | null {
  const message = params.messages.find(
    (m) => m && m.role === 'assistant' && (m.stopReason === 'error' || m.errorMessage),
  );
  if (!message) return null;

  const fullErrText = String(message.errorMessage || 'Unknown SDK error in _runLoop catch path');
  const codexProvider = params.provider === 'openai-codex';
  const isCodexUsageLimit = codexProvider && params.isCodexUsageLimitError(fullErrText);
  const isCodexAuthInvalid = codexProvider && params.isCodexAuthInvalidatedError(fullErrText);
  const isTransientAbort = !isCodexUsageLimit && !isCodexAuthInvalid && params.isPiTransientAbortError(fullErrText);

  return {
    carriedError: true,
    fullErrText,
    errText: fullErrText.slice(0, 500),
    stopReason: message.stopReason,
    isCodexUsageLimit,
    isCodexAuthInvalid,
    isTransientAbort,
    shouldAutoRetryTransient: isTransientAbort && params.canAutoRetryTransientAbort(),
  };
}
