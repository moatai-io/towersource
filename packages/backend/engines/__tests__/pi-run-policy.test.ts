import { describe, expect, it, vi } from 'vitest';

async function loadRunPolicy(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  const original: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    original[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const mod = await import('../pi/run-policy.js');
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return mod;
}

describe('Pi run policy helpers', () => {
  it('formats stable Korean watchdog reasons', async () => {
    const { formatWatchdogReason } = await loadRunPolicy();

    expect(formatWatchdogReason('idle', 90_000, 120_000)).toContain('스트림 무응답 90초');
    expect(formatWatchdogReason('thinking-stuck', 90_000, 120_000)).toContain('Thinking 단계가 120초');
    expect(formatWatchdogReason('text-stuck', 90_000, 120_000)).toContain('Text 응답이 120초');
    expect(formatWatchdogReason('toolcall-stuck', 90_000, 120_000)).toContain('Tool call 생성이 120초');
  });

  it('does not auto-replay generic connection drops inside a poisoned session branch', async () => {
    const { getTransientAbortRetryMax, getTransientAbortRetryDelayMs } = await loadRunPolicy({
      PI_TRANSIENT_ABORT_RETRY_MAX: '4',
      PI_ROUTER_RESTART_RETRY_BACKOFF_MS: '12345',
    });

    expect(getTransientAbortRetryMax('connection error')).toBe(0);
    expect(getTransientAbortRetryMax('cannot connect to host api.example.com')).toBe(0);
    expect(getTransientAbortRetryDelayMs('connection error', 1)).toBe(12345);
  });

  it('uses bounded short backoff for non-generic transient aborts', async () => {
    const { TRANSIENT_ABORT_RETRY_MAX, getTransientAbortRetryMax, getTransientAbortRetryDelayMs } = await loadRunPolicy({
      PI_TRANSIENT_ABORT_RETRY_MAX: '3',
      PI_ROUTER_RESTART_RETRY_BACKOFF_MS: '99999',
    });

    expect(TRANSIENT_ABORT_RETRY_MAX).toBe(3);
    expect(getTransientAbortRetryMax('SSE stream_incomplete upstream websocket closed')).toBe(3);
    expect(getTransientAbortRetryMax('litellm-responses API error (502): 502 Bad Gateway')).toBe(3);
    expect(getTransientAbortRetryDelayMs('SSE stream_incomplete upstream websocket closed', 1)).toBe(1000);
    expect(getTransientAbortRetryDelayMs('SSE stream_incomplete upstream websocket closed', 2)).toBe(3000);
    expect(getTransientAbortRetryDelayMs('SSE stream_incomplete upstream websocket closed', 99)).toBe(3000);
  });

  it('uses five bounded durable-friendly backoff steps for provider capacity overloads', async () => {
    const { PROVIDER_CAPACITY_RETRY_MAX, getTransientAbortRetryMax, getTransientAbortRetryDelayMs } = await loadRunPolicy({
      PI_TRANSIENT_ABORT_RETRY_MAX: '2',
      PI_PROVIDER_CAPACITY_RETRY_MAX: '5',
    });

    const overload = 'server_is_overloaded: Our servers are currently overloaded. Please try again later.';
    expect(PROVIDER_CAPACITY_RETRY_MAX).toBe(5);
    expect(getTransientAbortRetryMax(overload)).toBe(5);
    expect([1, 2, 3, 4, 5].map(attempt => getTransientAbortRetryDelayMs(overload, attempt)))
      .toEqual([30_000, 60_000, 90_000, 120_000, 180_000]);
    expect(getTransientAbortRetryDelayMs(overload, 99)).toBe(180_000);
    // Foreground failure schedules attempt 1 after 30s. Recovery attempt N that
    // fails schedules attempt N+1 using the next delay; attempt 5 is terminal.
    expect([0, 1, 2, 3, 4].map(recoveryAttempt => getTransientAbortRetryDelayMs(overload, recoveryAttempt + 1)))
      .toEqual([30_000, 60_000, 90_000, 120_000, 180_000]);
  });

  it('caps provider capacity and continuation retry overrides at their safe limits', async () => {
    const { PROVIDER_CAPACITY_RETRY_MAX, TRANSIENT_CONTINUATION_RETRY_MAX, getTransientAbortRetryMax } = await loadRunPolicy({
      PI_PROVIDER_CAPACITY_RETRY_MAX: '99',
      PI_TRANSIENT_CONTINUATION_RETRY_MAX: '99',
    });

    const overload = 'No available accounts. all upstream accounts are unavailable';
    expect(PROVIDER_CAPACITY_RETRY_MAX).toBe(99);
    expect(TRANSIENT_CONTINUATION_RETRY_MAX).toBe(99);
    expect(getTransientAbortRetryMax(overload)).toBe(5);
  });

  it('classifies transport abort strings through the shared failure classifier', async () => {
    const { isPiTransientAbortError } = await loadRunPolicy();

    expect(isPiTransientAbortError('This operation was aborted')).toBe(true);
    expect(isPiTransientAbortError('upstream websocket closed before response completed')).toBe(true);
    expect(isPiTransientAbortError('litellm-responses API error (502): 502 <html><title>502 Bad Gateway</title></html>')).toBe(true);
    expect(isPiTransientAbortError('authentication token has been invalidated')).toBe(false);
    expect(isPiTransientAbortError("API Error (503): 'dict' object has no attribute 'usage'")).toBe(true);
  });
});

 describe('usage-shape bounded retry', () => {
  it('caps retry at two even when transport retry configuration is higher', async () => {
    const policy = await loadRunPolicy({ PI_TRANSIENT_ABORT_RETRY_MAX: '9' });
    const message = "'dict' object has no attribute 'usage'";
    expect(policy.getTransientAbortRetryMax(message)).toBe(2);
    expect(policy.getTransientAbortRetryDelayMs(message, 1)).toBe(30_000);
    expect(policy.getTransientAbortRetryDelayMs(message, 2)).toBe(90_000);
  });
});
