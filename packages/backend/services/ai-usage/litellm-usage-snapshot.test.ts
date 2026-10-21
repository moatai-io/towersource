import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRouterUsageSnapshots, readRouterUsage } from './litellm-usage-snapshot.js';
import type { LiteLLMSelfServiceUsage } from './litellm-usage-client.js';

const request = { identity: 'vm-a', scope: 'team' as const, period: 'calendar_month' as const, days: 30 };
const usage: LiteLLMSelfServiceUsage = {
  source: 'litellm-spendlogs', scope: 'team', period: 'calendar_month', days: 30,
  key: {}, team: {}, summary: { cost_usd: 3 }, budget_window: null, daily: [], models: [], projects: [],
};
const failing = async (): Promise<LiteLLMSelfServiceUsage> => { throw new Error('router offline'); };

beforeEach(clearRouterUsageSnapshots);

describe('last-known Router usage', () => {
  it('serves the exact identity/scope/period/days snapshot with observed time on outage', async () => {
    const live = await readRouterUsage(request, async () => usage, () => Date.parse('2026-09-22T00:00:00Z'));
    expect(live?.freshness).toBe('live');
    const stale = await readRouterUsage(request, failing, () => Date.parse('2026-09-22T01:00:00Z'));
    expect(stale).toEqual({ ...live, freshness: 'stale' });
    expect(await readRouterUsage({ ...request, identity: 'vm-b' }, failing)).toBeNull();
    expect(await readRouterUsage({ ...request, scope: 'key' }, failing)).toBeNull();
    expect(await readRouterUsage({ ...request, days: 7 }, failing)).toBeNull();
  });

  it('accepts a VM-key-authenticated Team daily rollup without accepting a different scope', async () => {
    const rollup = { ...usage, source: 'litellm-daily-team-spend' as const, models: [{ model: 'smartest', cost_usd: 3 }] };
    const live = await readRouterUsage(request, async () => rollup);
    expect(live).toMatchObject({ freshness: 'live', usage: { source: 'litellm-daily-team-spend', scope: 'team' } });
    expect(await readRouterUsage({ ...request, scope: 'key' }, async () => rollup)).toBeNull();
  });

  it('expires snapshots after 24 hours rather than claiming indefinite canonical data', async () => {
    await readRouterUsage(request, async () => usage, () => 1_000_000);
    expect(await readRouterUsage(request, failing, () => 1_000_000 + 24 * 60 * 60 * 1000 + 1)).toBeNull();
  });

  it('never stores a mismatched response as the requested boundary', async () => {
    expect(await readRouterUsage(request, async () => ({ ...usage, scope: 'key' }))).toBeNull();
    expect(await readRouterUsage(request, failing)).toBeNull();
  });
});


describe('Router usage load control', () => {
  it('coalesces ten simultaneous reads and reuses the result for 30 seconds', async () => {
    let time = 1_000_000;
    const fetch = vi.fn(async () => usage);
    const results = await Promise.all(Array.from({ length: 10 }, () => readRouterUsage(request, fetch, () => time)));
    expect(fetch).toHaveBeenCalledTimes(1);
    time += 29_999;
    expect(await readRouterUsage(request, fetch, () => time)).toEqual(results[0]);
    expect(fetch).toHaveBeenCalledTimes(1);
    time++;
    await readRouterUsage(request, fetch, () => time);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('releases failed requests for retry rather than caching an outage', async () => {
    const fetch = vi.fn(failing);
    expect(await readRouterUsage(request, fetch)).toBeNull();
    expect(await readRouterUsage(request, fetch)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not share results across identity or day boundaries', async () => {
    const fetch = vi.fn(async (r: typeof request) => ({ ...usage, days: r.days }));
    await Promise.all([request, { ...request, identity: 'vm-b' }, { ...request, days: 7 }].map(r => readRouterUsage(r, fetch)));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('invalidates in-flight results without clearing a replacement request', async () => {
    let resolveOld!: (value: typeof usage) => void;
    const old = readRouterUsage(request, () => new Promise(resolve => { resolveOld = resolve; }));
    await Promise.resolve();
    clearRouterUsageSnapshots();
    const fresh = vi.fn(async () => ({ ...usage, summary: { cost_usd: 9 } }));
    const replacement = readRouterUsage(request, fresh);
    resolveOld(usage);
    expect(await old).toBeNull();
    expect((await replacement)?.usage.summary).toEqual({ cost_usd: 9 });
    expect((await readRouterUsage(request, fresh))?.usage.summary).toEqual({ cost_usd: 9 });
    expect(fresh).toHaveBeenCalledTimes(1);
  });
});
