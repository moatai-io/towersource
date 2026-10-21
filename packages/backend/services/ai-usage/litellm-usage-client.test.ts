import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  credentials: vi.fn(),
}));

vi.mock('../ai/litellm-credentials.js', () => ({
  resolveLiteLLMCredentials: mocks.credentials,
}));

import { fetchLiteLLMSelfServiceUsage, liteLLMUsageIdentity } from './litellm-usage-client.js';

describe('LiteLLM self-service usage client', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    mocks.credentials.mockReset().mockResolvedValue({
      baseUrl: 'https://router.example.com/v1',
      apiKey: 'synthetic-virtual-key',
    });
  });

  it('uses the current virtual key and does not accept caller-selected key/team ids', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      source: 'litellm-spendlogs', scope: 'team', period: 'calendar_month', days: 30,
      key: {}, team: {}, summary: {}, budget_window: null, daily: [], models: [], projects: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchLiteLLMSelfServiceUsage({ scope: 'team', days: 30 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://router.example.com/usage-self-service/v1/usage?scope=team&period=calendar_month&days=30');
    expect(String(url)).not.toContain('team_id');
    expect(String(url)).not.toContain('api_key');
    expect(init.headers.Authorization).toBe('Bearer synthetic-virtual-key');
  });

  it('preserves a separately identified budget window', async () => {
    const window = { starts_at: '2026-09-01T00:00:00+00:00', resets_at: '2026-10-01T00:00:00+00:00', cost_usd: 12 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      source: 'litellm-spendlogs', scope: 'team', period: 'lifetime', days: 7,
      key: {}, team: {}, summary: { cost_usd: 40 }, budget_window: window,
      daily: [], models: [], projects: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const usage = await fetchLiteLLMSelfServiceUsage({ period: 'lifetime', days: 7 });
    expect(usage.summary).toEqual({ cost_usd: 40 });
    expect(usage.budget_window).toEqual(window);
  });

  it('rejects a response whose scope differs from the requested boundary', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      source: 'litellm-spendlogs', scope: 'key', period: 'calendar_month', days: 30,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    await expect(fetchLiteLLMSelfServiceUsage({ scope: 'team' })).rejects.toThrow('invalid scope contract');
  });
  it('rejects malformed and period-mismatched canonical responses', async () => {
    for (const extra of [{ period: 'lifetime' }, { days: 7 }, { daily: null }, { summary: [] }]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
        source: 'litellm-spendlogs', scope: 'team', period: 'calendar_month', days: 30,
        key: {}, team: {}, summary: {}, budget_window: null, daily: [], models: [], projects: [], ...extra,
      }))));
      await expect(fetchLiteLLMSelfServiceUsage()).rejects.toThrow('invalid scope contract');
    }
  });

  it('isolates snapshots when the configured usage service changes', async () => {
    const initial = await liteLLMUsageIdentity();
    vi.stubEnv('LITELLM_USAGE_BASE_URL', 'https://usage.example.com');
    expect(await liteLLMUsageIdentity()).not.toBe(initial);
  });

});
