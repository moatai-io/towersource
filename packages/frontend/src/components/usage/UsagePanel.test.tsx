import { routerUsageView } from './usage-data';
// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsagePanel, ModelUsageSection } from './UsagePanel';
import ko from '../../locales/ko/common.json';
import { activityFixture, fallbackFixture, routerFixture } from './usage-fixtures';

vi.mock('react-i18next', () => ({ useTranslation: () => ({}) }));
vi.mock('../../stores/settings-store', () => ({ useSettingsStore: (select: (state: { theme: string }) => unknown) => select({ theme: 'dark' }) }));
vi.mock('../../i18n', () => ({ default: { t: (key: string, options: Record<string, unknown> = {}) => {
  const text = (ko.usage as Record<string, string>)[key.replace('usage.', '')] || key;
  return text.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name] ?? ''));
} } }));
const fetchMock = vi.fn();
const ok = (data: unknown) => ({ ok: true, json: async () => data });
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async (url: string) => ok(url.includes('usage-heatmap') ? activityFixture : routerFixture(Number(new URL(url, 'http://test').searchParams.get('days')))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('UsagePanel behavioral contract', () => {
  it('requests Team canonical first and displays distinct monthly/daily/budget values', async () => {
    render(<UsagePanel />);
    const section = await screen.findByRole('region', { name: ko.usage.teamCanonical });
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain('/api/metrics/router-ai-usage?scope=team&period=calendar_month&days=30');
    expect(fetchMock.mock.calls.some(([url]) => url.startsWith('/api/metrics/ai-usage?'))).toBe(false);
    expect(within(section).getByText('$12.3')).toBeTruthy();
    expect(within(section).getByText(ko.usage.calendarMonthRange.replace('{{start}}', '2026-09-01').replace('{{end}}', '2026-10-01'))).toBeTruthy();
    expect(within(section).getByText(ko.usage.billingUnverified)).toBeTruthy();
    expect(within(section).getByText('$4.0')).toBeTruthy();
    expect(within(section).getByText('$46.0')).toBeTruthy();
    expect(within(section).getAllByText(ko.usage.teamBalance)).toHaveLength(2);
    expect(within(section).getByText('$-388.0')).toBeTruthy();
    const table = within(section).getByRole('table');
    expect(within(table).getByText('120')).toBeTruthy();
    const missingDay = within(table).getByText('2026-08-25').closest('tr')!;
    expect(within(missingDay).getAllByText('0')).toHaveLength(4);
    expect(within(missingDay).getByText('$0.0')).toBeTruthy();
    expect(within(table).getByText('$1.3')).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: ko.usage.requests })).toBeTruthy();
    expect(screen.getByText('피크일').parentElement?.textContent).toContain('100');
    expect(screen.getByText('피크일').parentElement?.textContent).toContain('2026-09-22');
  });
  it('shows stale warning and snapshot time without silently switching to fallback', async () => {
    fetchMock.mockImplementation(async (url: string) => ok(url.includes('usage-heatmap') ? activityFixture : { ...routerFixture(), freshness: 'stale' }));
    render(<UsagePanel />);
    expect((await screen.findByRole('alert')).textContent).toContain('2026-09-23T12:00:00Z');
    expect(screen.getByRole('region', { name: ko.usage.teamCanonical })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => url.startsWith('/api/metrics/ai-usage?'))).toBe(false);
  });
  it('explicitly marks Router failure fallback as current VM, never Team total', async () => {
    fetchMock.mockImplementation(async (url: string) => url.includes('router-ai-usage') ? { ok: false, status: 503 } : ok(url.includes('usage-heatmap') ? activityFixture : fallbackFixture));
    render(<UsagePanel />);
    const section = await screen.findByRole('region', { name: ko.usage.vmEstimate });
    expect(within(section).getByRole('alert').textContent).toContain('Router HTTP 503');
    expect(within(section).getByRole('columnheader', { name: ko.usage.responseRecords })).toBeTruthy();
    expect(screen.queryByRole('region', { name: ko.usage.teamCanonical })).toBeNull();
  });
  it('marks legacy SpendLogs as current-key limited and counts requests without an exactness claim', async () => {
    const fallback = { ...fallbackFixture, usage: { ...fallbackFixture.usage, source: 'litellm-spend-logs', accuracy: 'key-window-unverified' } };
    fetchMock.mockImplementation(async (url: string) => url.includes('router-ai-usage') ? { ok: false, status: 404 } : ok(url.includes('usage-heatmap') ? activityFixture : fallback));
    render(<UsagePanel />);
    const section = await screen.findByRole('region', { name: ko.usage.keyEstimate });
    expect(within(section).getByRole('columnheader', { name: ko.usage.requests })).toBeTruthy();
    expect(within(section).getByText(ko.usage.keyBudget)).toBeTruthy();
    expect(section.textContent).not.toContain('정확 집계');
  });
  it('aborts pending requests on unmount without starting a fallback request', async () => {
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((_url: string, options: RequestInit) => {
      signals.push(options.signal as AbortSignal);
      return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    });
    const mounted = render(<UsagePanel />);
    mounted.unmount();
    await act(async () => {});
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('shows explicit unavailable and dashes when both endpoints fail, but keeps activity', async () => {
    fetchMock.mockImplementation(async (url: string) => url.includes('usage-heatmap') ? ok(activityFixture) : { ok: false, status: 503 });
    render(<UsagePanel />);
    const section = await screen.findByRole('region', { name: ko.usage.unavailable });
    expect(within(section).getAllByText('—')).toHaveLength(8);
    expect(within(section).queryByRole('table')).toBeNull();
    expect(screen.getByText('피크일').parentElement?.textContent).toContain('100');
  });
  it('keeps canonical usage visible when activity fetch fails', async () => {
    fetchMock.mockImplementation(async (url: string) => url.includes('usage-heatmap') ? { ok: false, status: 500 } : ok(routerFixture()));
    render(<UsagePanel />);
    expect(await screen.findByRole('region', { name: ko.usage.teamCanonical })).toBeTruthy();
    expect(screen.getByText(/usage heatmap HTTP 500/)).toBeTruthy();
  });
  it('does not reload token usage when only Top-N changes', async () => {
    render(<UsagePanel />);
    await screen.findByRole('region', { name: ko.usage.teamCanonical });
    const before = fetchMock.mock.calls.filter(([url]) => url.includes('router-ai-usage')).length;
    fireEvent.change(screen.getByTitle(ko.usage.projectCountTitle), { target: { value: '30' } });
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.includes('usage-heatmap') && url.includes('top=30'))).toBe(true));
    expect(fetchMock.mock.calls.filter(([url]) => url.includes('router-ai-usage'))).toHaveLength(before);
  });
  it('aborts a prior range and ignores its late response, even if fetch ignores abort', async () => {
    let resolveOld!: (value: unknown) => void;
    let oldSignal!: AbortSignal;
    fetchMock.mockImplementation((url: string, options: RequestInit) => {
      if (url.includes('usage-heatmap')) return Promise.resolve(ok(activityFixture));
      const days = Number(new URL(url, 'http://test').searchParams.get('days'));
      if (days === 30) {
        oldSignal = options.signal as AbortSignal;
        return new Promise(resolve => { resolveOld = resolve; });
      }
      const fixture = routerFixture(days);
      fixture.usage.summary.cost_usd = 7.77;
      return Promise.resolve(ok(fixture));
    });
    render(<UsagePanel />);
    fireEvent.click(screen.getByRole('button', { name: '7일' }));
    await screen.findByText('$7.8');
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { resolveOld(ok(routerFixture())); });
    expect(screen.queryByText('$12.3')).toBeNull();
    expect(screen.getByText('$7.8')).toBeTruthy();
  });
  it('shows an empty daily state without fabricating chart dates', async () => {
    const fixture = routerFixture();
    fixture.usage.daily = [];
    fetchMock.mockImplementation(async (url: string) => ok(url.includes('usage-heatmap') ? activityFixture : fixture));
    render(<UsagePanel />);
    expect(await screen.findByText(ko.usage.noDailyUsage)).toBeTruthy();
    const section = screen.getByRole('region', { name: ko.usage.teamCanonical });
    expect(within(section).queryByRole('table')).toBeNull();
    expect(within(section).getByText('$12.3')).toBeTruthy();
  });
  it('refresh retries canonical usage after an explicit unavailable result', async () => {
    fetchMock.mockImplementation(async (url: string) => url.includes('usage-heatmap') ? ok(activityFixture) : { ok: false, status: 503 });
    render(<UsagePanel />);
    await screen.findByRole('region', { name: ko.usage.unavailable });
    fetchMock.mockImplementation(async (url: string) => ok(url.includes('usage-heatmap') ? activityFixture : routerFixture()));
    await waitFor(() => expect((screen.getByTitle(ko.usage.refresh) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTitle(ko.usage.refresh));
    expect(await screen.findByRole('region', { name: ko.usage.teamCanonical })).toBeTruthy();
  });
  it('shows recorded model costs, total-based shares, and expands beyond the top five', () => {
    const fixture = routerFixture();
    const models = Array.from({ length: 6 }, (_, i) => ({ model: `route-${i}`, cost_usd: i + 1, requests: 2 }));
    const view = routerUsageView({ ...fixture, usage: { ...fixture.usage, models,
      summary: { ...fixture.usage.summary, cost_usd: 21 } } }, 30);
    render(<ModelUsageSection usage={view} />);
    fireEvent.click(screen.getByText(new RegExp(ko.usage.modelDetails)));
    expect(screen.getByText('$6.0')).toBeTruthy();
    expect(screen.getByText('28.6%')).toBeTruthy();
    expect(screen.queryByText('route-0')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /전체 모델 보기/ }));
    expect(screen.getByText('route-0')).toBeTruthy();
    expect(screen.getByText(ko.usage.recordedCostNote)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: ko.usage.fewerModels }));
    expect(screen.queryByText('route-0')).toBeNull();
  });

  it('keeps the model section visible when Team usage fails', async () => {
    fetchMock.mockImplementation(async (url: string) => url.includes('router-ai-usage')
      ? { ok: false, status: 503 }
      : ok(url.includes('usage-heatmap') ? activityFixture : fallbackFixture));
    render(<UsagePanel />);
    const models = await screen.findByRole('region', { name: ko.usage.modelDailyTitle });
    expect(within(models).getByText(ko.usage.modelsConnectionRequired)).toBeTruthy();
    expect(within(models).queryByRole('table')).toBeNull();
  });

  it('shows daily model costs only when they reconcile with daily totals', () => {
    const fixture = routerFixture(31);
    const usage = { ...fixture.usage, source: 'litellm-daily-team-spend',
      daily_window: { starts_on: '2026-08-24', ends_before: '2026-09-24', timezone: 'UTC' },
      model_daily: [
        { date: '2026-08-24', model: 'smartest', cost_usd: 1.25, requests: 3 },
        { date: '2026-09-23', model: 'smartest', cost_usd: 2.5, requests: 5 },
      ],
      models: [{ model: 'smartest', cost_usd: 12.34, requests: 19 }],
    };
    const view = routerUsageView({ ...fixture, usage, }, 31);
    render(<ModelUsageSection usage={view} />);
    expect(screen.getByRole('img', { name: ko.usage.modelDailyChart })).toBeTruthy();
    expect(screen.getByRole('region', { name: ko.usage.modelDailyTitle })).toBeTruthy();
    const dateArea = screen.getByRole('button', { name: '2026-08-24' });
    fireEvent.mouseEnter(dateArea);
    expect(screen.getByRole('tooltip').textContent).toContain('smartest');
    expect(screen.getByRole('tooltip').textContent).toContain('$1.25');
    expect(screen.getByRole('tooltip').textContent).toContain('3');
    fireEvent.mouseLeave(dateArea.closest('div')!);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(dateArea);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(dateArea, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();

    cleanup();
    const withoutMonthlyModels = routerUsageView({ ...fixture, usage: { ...usage, models: [] } }, 31);
    render(<ModelUsageSection usage={withoutMonthlyModels} />);
    expect(screen.getByRole('img', { name: ko.usage.modelDailyChart })).toBeTruthy();
    cleanup();
    const mismatched = routerUsageView({ ...fixture, usage: { ...usage, model_daily: [
      { date: '2026-08-24', model: 'smartest', cost_usd: 1.2, requests: 3 },
    ] } }, 31);
    render(<ModelUsageSection usage={mismatched} />);
    expect(screen.getByText(ko.usage.modelDailyMismatch)).toBeTruthy();
    expect(screen.queryByRole('img', { name: ko.usage.modelDailyChart })).toBeNull();
  });

});
