import { describe, expect, it } from 'vitest';
import { activityStats, fallbackUsageView, routerUsageView } from './usage-data';
import { activityFixture, fallbackFixture, routerFixture } from './usage-fixtures';

describe('monthly history', () => {
  it('keeps retained months descending and rejects malformed months', () => {
    const fixture = routerFixture();
    const view = routerUsageView({ ...fixture, usage: { ...fixture.usage, monthly: [
      { month: '2026-09', cost_usd: 12, requests: 3 },
      { month: '2026-10', cost_usd: 0, requests: 0 },
      { month: '2026-99', cost_usd: 50 },
    ] } }, 30);
    expect(view.monthly?.map(row => row.month)).toEqual(['2026-10', '2026-09']);
    expect(view.monthly?.[0]).toMatchObject({ costUsd: 0, count: 0 });
  });
  it('does not fabricate history for older sidecars', () => {
    expect(routerUsageView(routerFixture(), 30).monthly).toBeUndefined();
  });
});

describe('usage scope and numeric fixtures', () => {
  it('keeps monthly summary, rolling daily rows and budget-window figures separate', () => {
    const view = routerUsageView(routerFixture(), 30);
    expect(view.summary).toEqual({ inputTokens: 8000, outputTokens: 2000, totalTokens: 10000, costUsd: 12.34, count: 19 });
    expect(view.daily.filter(day => day.count).map(day => day.totalTokens)).toEqual([120, 240]);
    expect(view.daily.filter(day => day.count).map(day => day.costUsd)).toEqual([1.25, 2.5]);
    expect(view.daily.filter(day => day.count).map(day => day.count)).toEqual([3, 5]);
    expect(view.daily).toHaveLength(31);
    expect(view.daily[1]).toMatchObject({ date: '2026-08-25', costUsd: 0, totalTokens: 0, count: 0 });
    expect(view.daily[0].date).toBe('2026-08-24'); // Do not trim the rolling first date to a UTC full-day window.
    expect(view.budget).toMatchObject({ spend: 4, limit: 50, remaining: 46 });
    expect(view.teamBalance).toEqual({ spend: 888, limit: 500, remaining: -388 });
    expect(view.countKind).toBe('requests');
  });
  it('does not substitute team/key counters or zero for an unavailable window', () => {
    const fixture = routerFixture();
    const view = routerUsageView({ ...fixture, usage: { ...fixture.usage, budget_window: null } }, 30);
    expect(view.budget).toMatchObject({ spend: null, limit: null, remaining: null });
    expect(view.teamBalance).toEqual({ spend: 888, limit: 500, remaining: -388 });
  });
  it('retains true zero but rejects missing or nonfinite metrics', () => {
    const fixture = routerFixture();
    const view = routerUsageView({ ...fixture, usage: { ...fixture.usage, summary: { cost_usd: 0, requests: Infinity } } }, 30);
    expect(view.summary).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, costUsd: 0, count: null });
  });
  it.each([{ scope: 'key' }, { period: 'lifetime' }, { days: 7 }])('rejects mismatched scope/period/window %j', (overrides) => {
    const fixture = routerFixture();
    expect(() => routerUsageView({ ...fixture, usage: { ...fixture.usage, ...overrides } }, 30)).toThrow('contract');
  });
  it('labels legacy SpendLogs counts as requests, not turns or exact Team usage', () => {
    const view = fallbackUsageView({ ...fallbackFixture, usage: { ...fallbackFixture.usage,
      source: 'litellm-spend-logs', accuracy: 'key-window-unverified' } }, 30, 'Router failed');
    expect(view).toMatchObject({ kind: 'fallback', fallbackSource: 'key', countKind: 'requests' });
  });
  it('labels local counts as assistant response records and hides unavailable placeholder zeroes', () => {
    expect(fallbackUsageView(fallbackFixture, 30, 'failed')).toMatchObject({ kind: 'fallback', fallbackSource: 'local', countKind: 'responseRecords' });
    const view = fallbackUsageView({ ...fallbackFixture, usage: { ...fallbackFixture.usage, source: 'unavailable' } }, 30, 'failed');
    expect(view.kind).toBe('unavailable');
    expect(view.summary.costUsd).toBeNull();
    expect(view.daily).toEqual([]);
  });
  it('calculates peak day over dailyTotals regardless of the Top-N displayed projects', () => {
    expect(activityStats(activityFixture).hottestDay).toEqual({ date: '2026-09-22', value: 100 });
    expect(activityStats({ ...activityFixture, projects: [] }).hottestDay).toEqual({ date: '2026-09-22', value: 100 });
    expect(activityStats(activityFixture).peakValue).toBe(10);
  });
  it('accepts explicit rollup windows and hides unsupported budget amounts', () => {
    const fixture = routerFixture();
    const usage = { ...fixture.usage, source: 'litellm-daily-team-spend',
      daily_window: { starts_on: '2026-09-01', ends_before: '2026-10-01', timezone: 'UTC' } };
    const view = routerUsageView({ ...fixture, usage }, 30);
    expect(view.rollup).toBe(true);
    expect(view.budget.spend).toBeNull();
    expect(view.teamBalance).toEqual({ spend: 888, limit: 500, remaining: -388 });
    expect(view.dailyWindow?.startsOn).toBe('2026-09-01');
    expect(() => routerUsageView({ ...fixture, usage: { ...usage,
      daily_window: { ...usage.daily_window, ends_before: '2026-10-02' } } }, 30)).toThrow('contract');
  });

  it('sorts models by recorded spend without repricing tokens or turning unknown cost into zero', () => {
    const fixture = routerFixture();
    const view = routerUsageView({ ...fixture, usage: { ...fixture.usage, models: [
      { model: 'smartest', cost_usd: 2, requests: 10, input_tokens: 999999 },
      { model: 'unknown-rate', requests: 1 },
      { model: 'historic-model', cost_usd: 8, requests: 1, input_tokens: 2 },
      { model: 'free', cost_usd: 0, requests: 3 },
    ] } }, 30);
    expect(view.models?.map(m => m.model)).toEqual(['historic-model', 'smartest', 'free', 'unknown-rate']);
    expect(view.models?.map(m => m.costUsd)).toEqual([8, 2, 0, null]);
    expect(view.models?.[1].inputTokens).toBe(999999);
  });

});
