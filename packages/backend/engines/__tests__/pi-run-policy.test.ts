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
    expect(getTransientAbortRetryDelayMs('SSE stream_incomplete upstream websocket closed', 1)).toBe(1000);
    expect(getTransientAbortRetryDelayMs('SSE stream_incomplete upstream websocket closed', 2)).toBe(3000);
    expect(getTransientAbortRetryDelayMs('SSE stream_incomplete upstream websocket closed', 99)).toBe(3000);
  });

  it('waits 30 seconds before retrying provider capacity overloads', async () => {
    const { getTransientAbortRetryMax, getTransientAbortRetryDelayMs } = await loadRunPolicy({
      PI_TRANSIENT_ABORT_RETRY_MAX: '4',
    });

    const overload = 'server_is_overloaded: Our servers are currently overloaded. Please try again later.';
    expect(getTransientAbortRetryMax(overload)).toBe(2);
    expect(getTransientAbortRetryDelayMs(overload, 1)).toBe(30_000);
    expect(getTransientAbortRetryDelayMs(overload, 2)).toBe(90_000);
    expect(getTransientAbortRetryDelayMs(overload, 99)).toBe(90_000);
  });

  it('classifies transport abort strings through the shared failure classifier', async () => {
    const { isPiTransientAbortError } = await loadRunPolicy();

    expect(isPiTransientAbortError('This operation was aborted')).toBe(true);
    expect(isPiTransientAbortError('upstream websocket closed before response completed')).toBe(true);
    expect(isPiTransientAbortError('authentication token has been invalidated')).toBe(false);
  });
});
