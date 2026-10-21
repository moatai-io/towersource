import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), credentials: vi.fn() }));
vi.mock('../../config.js', () => ({ config: { publicUrl: 'https://app.example.com' } }));
vi.mock('../../db/pg-repo.js', () => ({ query: mocks.query }));
vi.mock('./litellm-credentials.js', () => ({ resolveLiteLLMCredentials: mocks.credentials }));
import { listAiTokenBudgetSnapshots } from './ai-token-budget.js';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const keyInfo = () => json({ key: 'synthetic-hash', info: { spend: 2, max_budget: 10, created_at: '2026-09-01T00:00:00Z' } });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-23T12:00:00Z'));
  vi.stubEnv('LITELLM_ADMIN_API_KEY', 'synthetic-admin');
  vi.stubEnv('LITELLM_MANAGEMENT_BASE_URL', '');
  vi.stubEnv('LITELLM_USAGE_SINCE', '');
  vi.stubEnv('LITELLM_BASE_URL', 'https://old.example.com/v1');
  mocks.credentials.mockReset().mockResolvedValue({ baseUrl: 'https://active.example.com/v1', apiKey: 'synthetic-vm' });
  mocks.query.mockReset().mockResolvedValue([{ d: '2026-09-23', input_tokens: 100, output_tokens: 20, cache_read_tokens: 30, cache_creation_tokens: 0, cost_usd: 0.4, turns: 1 }]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('VM fallback usage behavior', () => {
  it('falls back on provider HTTP failure rather than returning a truthy unavailable zero', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(keyInfo()).mockResolvedValueOnce(json({}, 503));
    vi.stubGlobal('fetch', fetcher);
    const result = await listAiTokenBudgetSnapshots(7);
    expect(result.usage.source).toBe('tower-db-metadata');
    expect(result.usage.totals.totalTokens).toBe(120);
    expect(result.usage.daily).toHaveLength(7);
    expect(result.usage.daily[0].date).toBe('2026-09-17');
    expect(String(fetcher.mock.calls[1][0])).toContain('https://active.example.com/spend/logs');
    expect(mocks.query.mock.calls[0][1]).toEqual(['2026-09-17T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-09-24T00:00:00.000Z']);
    expect(mocks.query.mock.calls[0][0]).toContain("created_at AT TIME ZONE 'UTC'");
  });
  it('falls back on malformed legacy payload and marks both failures unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(keyInfo()).mockResolvedValueOnce(json({ data: [] })));
    mocks.query.mockRejectedValueOnce(new Error('DB unavailable'));
    const result = await listAiTokenBudgetSnapshots(7);
    expect(result.usage.source).toBe('unavailable');
    expect(result.usage.accuracy).toBe('unavailable');
  });
  it('does not claim complete key-exact usage for an unpaginated legacy array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(keyInfo()).mockResolvedValueOnce(json([
      { api_key: 'synthetic-hash', status: 'success', startTime: '2026-09-23T10:00:00Z', prompt_tokens: 100, completion_tokens: 10, spend: 0.3 },
      { api_key: 'another-key', status: 'success', startTime: '2026-09-23T10:00:00Z', prompt_tokens: 900, completion_tokens: 90, spend: 3 },
    ])));
    const result = await listAiTokenBudgetSnapshots(7);
    expect(result.usage.accuracy).toBe('key-window-unverified');
    expect(result.usage.totals.totalTokens).toBe(110);
    expect(result.usage.totals.costUsd).toBe(0.3);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

it('shares an eight-second external deadline rather than restarting it for spend logs', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const fetcher = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(keyInfo()), 6_000)))
      .mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }));
    vi.stubGlobal('fetch', fetcher);
    const pending = listAiTokenBudgetSnapshots(7);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(mocks.query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).usage.source).toBe('tower-db-metadata');
    expect(warn).toHaveBeenCalledWith('[usage-fallback] slow lookup', {
      budgetMs: 6_000, spendLogsMs: 2_000, localMs: 0, totalMs: 8_000, usedLocalFallback: true,
    });
    expect(vi.getTimerCount()).toBe(0);
  } finally { warn.mockRestore(); }
});
