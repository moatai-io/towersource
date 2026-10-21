import { useState, useEffect, useMemo, useCallback, useRef, useId } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { useSettingsStore } from '../../stores/settings-store';
import { activityStats, fetchUsageView, type UsageView, type UsageDay } from './usage-data';

// ───── Types ─────
interface ProjectRow {
  id: string;
  name: string;
  total: number;
  sessions: number;
  activeDays: number;
  values: number[];
}
interface HeatmapResponse {
  days: number;
  topN: number;
  dates: string[];
  projects: ProjectRow[];
  grandTotal: number;
  dailyTotals: number[];
}

// ───── Color scale (log-ish buckets) — theme-aware ─────
// Dark mode: deep-green → bright-green → yellow (matches html-sandbox prototype)
// Light mode: very-light-gray → green grades → amber (GitHub-contribution style)
function colorFor(v: number, isDark: boolean): string {
  if (isDark) {
    if (v === 0) return '#1f2937';    // neutral gray
    if (v <= 3) return '#14532d';     // deepest green (low)
    if (v <= 10) return '#166534';
    if (v <= 30) return '#16a34a';
    if (v <= 80) return '#4ade80';    // bright green
    return '#fde047';                  // yellow = hot
  }
  // Light mode
  if (v === 0) return '#f3f4f6';      // very light gray (no activity)
  if (v <= 3) return '#bbf7d0';       // green-200 (faint)
  if (v <= 10) return '#86efac';      // green-300
  if (v <= 30) return '#22c55e';      // green-500
  if (v <= 80) return '#15803d';      // green-700 (deep)
  return '#f59e0b';                    // amber-500 = hot
}

const RANGE_OPTIONS = [7, 14, 30, 60, 90];

function tr(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, { ns: 'common', ...options });
}

const TOP_OPTIONS = [10, 20, 30, 50];

function formatShortDate(iso: string): string {
  // 'YYYY-MM-DD' → 'MM-DD'
  return iso.slice(5);
}

function formatMoney(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
}

function formatTokens(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function weekdayIdx(iso: string): number {
  // 0 = Sun ... 6 = Sat
  return new Date(iso + 'T00:00:00').getDay();
}

interface UsagePanelProps {
  embedded?: boolean;
}

export function UsagePanel({ embedded = false }: UsagePanelProps) {
  useTranslation('common');
  const theme = useSettingsStore((s) => s.theme);
  const isDark = theme !== 'light';
  const [days, setDays] = useState<number>(30);
  const [top, setTop] = useState<number>(20);
  const [data, setData] = useState<HeatmapResponse | null>(null);
  const [aiUsage, setAiUsage] = useState<UsageView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<{ project: string; date: string; value: number; x: number; y: number } | null>(null);

  const activeRequest = useRef<AbortController | null>(null);
  const usageForDays = useRef<{ days: number; value: UsageView; fetchedAt: number } | null>(null);
  const load = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    setError(null);
    // Never show a prior range's values beneath the new range controls.
    setData(null);
    // Top-N changes only affect the heatmap; avoid reloading token usage for the same range.
    const cachedUsage = usageForDays.current?.days === days &&
      Date.now() - usageForDays.current.fetchedAt < 60_000 && usageForDays.current.value.kind !== 'unavailable'
      ? usageForDays.current.value : null;
    setAiUsage(cachedUsage);
    setHover(null);
    const token = localStorage.getItem('token');
    const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
    await Promise.all([
      (async () => {
        try {
          const response = await fetch(`/api/metrics/usage-heatmap?days=${days}&top=${top}`, { headers, signal: controller.signal });
          if (!response.ok) throw new Error(`usage heatmap HTTP ${response.status}`);
          const json: HeatmapResponse = await response.json();
          if (!controller.signal.aborted) setData(json);
        } catch (error) {
          if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Failed to load');
        }
      })(),
      (async () => {
        if (cachedUsage) return;
        try {
          const result = await fetchUsageView(days, headers, controller.signal);
          if (!controller.signal.aborted) {
            usageForDays.current = { days, value: result, fetchedAt: Date.now() };
            setAiUsage(result);
          }
        } catch (error) {
          if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Failed to load');
        }
      })(),
    ]);
    if (!controller.signal.aborted) setLoading(false);
  }, [days, top]);

  useEffect(() => {
    void load();
    return () => activeRequest.current?.abort();
  }, [load]);

  const stats = useMemo(() => data ? activityStats(data) : null, [data]);

  // ───── Cell size — shrinks with wider ranges OR larger Top-N to fit ─────
  const cellByDays = days <= 14 ? 28 : days <= 30 ? 22 : days <= 60 ? 14 : 10;
  const cellCapByTop = top <= 20 ? Infinity : top <= 30 ? 16 : 12;
  const cell = Math.min(cellByDays, cellCapByTop);
  const gap = days <= 30 && top <= 20 ? 2 : 1;
  const labelWidth = 180;
  const totalWidth = 60;

  return (
    <div className={embedded ? 'min-h-full' : 'flex-1 overflow-auto bg-surface-950'}>
      <div className={embedded ? 'mx-auto max-w-[1500px]' : 'max-w-[1400px] mx-auto p-6'}>
        {/* ── Header ── */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-100">{tr('usage.title', { defaultValue: '사용량' })}</h1>
            <p className="text-[14px] text-gray-500 mt-0.5">
              {tr('usage.description')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Range selector */}
            <div className="flex bg-surface-900 border border-surface-800 rounded-lg p-0.5">
              {RANGE_OPTIONS.map((optionDays) => (
                <button
                  key={optionDays}
                  onClick={() => setDays(optionDays)}
                  className={`px-2.5 py-1 text-[13px] rounded-md transition-colors ${
                    days === optionDays
                      ? 'bg-primary-600/30 text-primary-300'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {tr('usage.days', { count: optionDays })}
                </button>
              ))}
            </div>
            {/* Top-N selector */}
            <select
              value={top}
              onChange={(e) => setTop(Number(e.target.value))}
              className="bg-surface-900 border border-surface-800 rounded-lg text-[13px] text-gray-300 px-2 py-1 outline-none focus:border-primary-500/50"
              title={tr('usage.projectCountTitle')}
            >
              {TOP_OPTIONS.map((n) => (
                <option key={n} value={n}>Top {n}</option>
              ))}
            </select>
            <button
              onClick={load}
              disabled={loading}
              className="px-2.5 py-1 text-[13px] text-gray-400 hover:text-gray-200 hover:bg-surface-800 rounded-md transition-colors disabled:opacity-50"
              title={tr('usage.refresh')}
            >
              {loading ? '…' : '↻'}
            </button>
          </div>
        </div>

        {/* ── AI/API Usage ── */}
        {aiUsage && <AiUsageSection aiUsage={aiUsage} isDark={isDark} />}
        {data?.dailyTotals?.length ? <div className="mb-6 border-t border-surface-800 pt-4">
          <p className="mb-2 text-xs text-gray-500">{tr('usage.activityScopeNote')}</p>
          <DailyLineChart dates={data.dates} values={data.dailyTotals} isDark={isDark} />
        </div> : null}

        {/* ── Summary cards ── */}
        {data && stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <SummaryCard
              label={tr('usage.totalUserTurns')}
              value={data.grandTotal.toLocaleString()}
              sub={tr('usage.dailyAverage', { days, average: stats.avgPerDay.toFixed(1) })}
            />
            <SummaryCard
              label={tr('usage.activeProjects')}
              value={String(data.projects.length)}
              sub={tr('usage.activeProjectsSub', { top })}
            />
            <SummaryCard
              label={tr('usage.peakDay')}
              value={stats.hottestDay.value.toLocaleString()}
              sub={stats.hottestDay.date || '—'}
            />
            <SummaryCard
              label={tr('usage.hottestCell')}
              value={String(stats.peakValue)}
              sub={stats.peakProject ? `${stats.peakProject} · ${stats.peakDate}` : '—'}
            />
          </div>
        )}

        {/* ── Error ── */}
        {error && (
          <div className="mb-4 p-3 bg-red-950/30 border border-red-900/50 rounded-lg text-[14px] text-red-300">
            {tr('usage.loadFailed', { error })}
          </div>
        )}

        {/* ── Loading ── */}
        {loading && !data && (
          <div className="p-12 text-center text-gray-500 text-[14px]">{tr('usage.loading')}</div>
        )}

        {/* ── Empty ── */}
        {!loading && data && data.projects.length === 0 && (
          <div className="p-12 text-center text-gray-500 text-[14px]">
            {tr('usage.empty', { days })}
          </div>
        )}

        {/* ── Heatmap ── */}
        {data && data.projects.length > 0 && (
          <div className="bg-surface-900 border border-surface-800 rounded-xl p-5 overflow-auto relative">
            <div
              className="inline-grid"
              style={{
                gridTemplateColumns: `${labelWidth}px repeat(${data.dates.length}, ${cell}px) ${totalWidth}px`,
                gap: `${gap}px`,
                alignItems: 'center',
              }}
            >
              {/* Header row */}
              <div />
              {data.dates.map((d, i) => {
                const showLabel = data.dates.length <= 31 || i % Math.ceil(data.dates.length / 31) === 0;
                const wd = weekdayIdx(d);
                const isWeekend = wd === 0 || wd === 6;
                return (
                  <div key={d} className="relative" style={{ height: 48 }}>
                    {showLabel && (
                      <span
                        className="absolute left-1/2 bottom-1 origin-left whitespace-nowrap text-[11px] font-mono"
                        style={{
                          transform: 'rotate(-55deg) translateX(0)',
                          color: isDark
                            ? (isWeekend ? '#6b7280' : '#9ca3af')
                            : (isWeekend ? '#9ca3af' : '#4b5563'),
                        }}
                      >
                        {formatShortDate(d)}
                      </span>
                    )}
                  </div>
                );
              })}
              <div className="text-[11px] text-gray-500 text-right pr-1 self-end pb-1">{tr('usage.total')}</div>

              {/* Project rows */}
              {data.projects.map((p) => (
                <Row key={p.id} project={p} dates={data.dates} cell={cell} isDark={isDark} onHover={setHover} />
              ))}
            </div>

            {/* Hover tooltip */}
            {hover && (
              <div
                className="pointer-events-none fixed z-[9999] bg-surface-950 border border-surface-700 rounded-lg px-2.5 py-1.5 text-[13px] text-gray-200 shadow-xl"
                style={{ left: hover.x + 12, top: hover.y + 12 }}
              >
                <div className="font-semibold text-primary-300">{hover.project}</div>
                <div className="text-gray-400">
                  {hover.date} · <span className="tone-warning tone-text font-mono">{hover.value}</span> turns
                </div>
              </div>
            )}

            {/* Legend */}
            <div className="mt-5 pt-4 border-t border-surface-800 flex items-center gap-2 text-[12px] text-gray-500">
              <span>{tr('usage.intensity')}</span>
              <LegendCell color={colorFor(0, isDark)} label="0" />
              <LegendCell color={colorFor(2, isDark)} label="1-3" />
              <LegendCell color={colorFor(7, isDark)} label="4-10" />
              <LegendCell color={colorFor(20, isDark)} label="11-30" />
              <LegendCell color={colorFor(60, isDark)} label="31-80" />
              <LegendCell color={colorFor(100, isDark)} label="81+" />
              <div className="flex-1" />
              <span className="text-gray-600">
                {tr('usage.hotDayHint', { color: isDark ? tr('usage.yellow') : tr('usage.amber') })}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ───── Row component ─────
function Row({
  project,
  dates,
  cell,
  isDark,
  onHover,
}: {
  project: ProjectRow;
  dates: string[];
  cell: number;
  isDark: boolean;
  onHover: (h: { project: string; date: string; value: number; x: number; y: number } | null) => void;
}) {
  return (
    <>
      <div
        className="text-[13px] text-gray-300 text-right pr-2.5 truncate"
        title={tr('usage.projectRowTitle', { project: project.name, turns: project.total, days: project.activeDays })}
      >
        {project.name}
      </div>
      {project.values.map((v, i) => (
        <div
          key={i}
          style={{
            width: cell,
            height: cell,
            background: colorFor(v, isDark),
            borderRadius: 2,
          }}
          className={`transition-transform hover:scale-[1.35] hover:ring-1 cursor-default ${
            isDark ? 'hover:ring-white/70' : 'hover:ring-gray-700/70'
          }`}
          onMouseEnter={(e) =>
            onHover({
              project: project.name,
              date: dates[i],
              value: v,
              x: e.clientX,
              y: e.clientY,
            })
          }
          onMouseMove={(e) =>
            onHover({
              project: project.name,
              date: dates[i],
              value: v,
              x: e.clientX,
              y: e.clientY,
            })
          }
          onMouseLeave={() => onHover(null)}
        />
      ))}
      <div className={`text-[13px] font-mono font-semibold text-right pl-2.5 tabular-nums ${
        'tone-warning tone-text'
      }`}>
        {project.total.toLocaleString()}
      </div>
    </>
  );
}

export function AiUsageSection({ aiUsage, isDark }: { aiUsage: UsageView; isDark: boolean }) {
  const { budget, teamBalance, summary, daily } = aiUsage;
  const team = aiUsage.kind === 'team';
  const sourceLabel = tr(team ? 'usage.teamCanonical' : aiUsage.kind === 'fallback'
    ? aiUsage.fallbackSource === 'key' ? 'usage.keyEstimate' : 'usage.vmEstimate' : 'usage.unavailable');
  const observed = aiUsage.observedAt ? new Date(aiUsage.observedAt) : null;
  const monthStart = team && observed && Number.isFinite(observed.getTime())
    ? new Date(Date.UTC(observed.getUTCFullYear(), observed.getUTCMonth(), 1)).toISOString().slice(0, 10) : null;
  const monthEnd = team && observed && Number.isFinite(observed.getTime())
    ? new Date(Date.UTC(observed.getUTCFullYear(), observed.getUTCMonth() + 1, 1)).toISOString().slice(0, 10) : null;
  const periodLabel = monthStart && monthEnd
    ? tr('usage.calendarMonthRange', { start: monthStart, end: monthEnd })
    : tr(team ? 'usage.calendarMonth' : 'usage.selectedWindow', { days: aiUsage.days });
  const budgetWindow = budget.startsAt && budget.resetsAt
    ? `${budget.startsAt} – ${budget.resetsAt}` : tr('usage.currentBudgetWindow');
  const pct = budget.spend !== null && budget.limit !== null && budget.limit > 0
    ? Math.min(100, Math.max(0, budget.spend / budget.limit * 100)) : null;

  return (
    <section aria-label={sourceLabel} className="mb-6 space-y-3">
      <header className="flex flex-wrap items-start justify-between gap-3 pb-2">
        <div><h2 className="text-lg font-semibold tracking-tight text-gray-200">{tr('usage.overviewTitle')}</h2>
          <p className="mt-1 text-sm text-gray-400">{aiUsage.teamName || sourceLabel}</p></div>
        <span className="rounded-md border border-surface-700 px-2.5 py-1 text-xs text-gray-400">{periodLabel}</span>
      </header>
      {aiUsage.freshness === 'stale' && <div role="alert" className="rounded-lg border border-surface-700 p-3 text-sm tone-warning tone-text">{tr('usage.staleSnapshot', { time: aiUsage.observedAt })}</div>}
      {!team && <div role="alert" className="rounded-lg border border-surface-700 bg-surface-900 p-4 space-y-2">
        <p className="text-sm font-medium tone-warning tone-text">{tr('usage.connectionPending')}</p>
        <p className="text-sm text-gray-400">{tr('usage.teamUnavailable')}</p>
        {aiUsage.warning && <details className="text-xs text-gray-500"><summary className="cursor-pointer">{tr('usage.connectionDetails')}</summary><p className="mt-2 font-mono break-words">{aiUsage.warning}</p></details>}
      </div>}
      <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_2fr] gap-5 border-y border-surface-800 py-5">
        <div className="space-y-2">
          <p className="text-sm text-gray-400">{tr(team ? 'usage.calendarMonthCost' : 'usage.periodCost')}</p>
          <p className="text-4xl font-semibold tracking-tight tabular-nums text-gray-200">{formatMoney(summary.costUsd)}</p>
          <p className="text-xs text-gray-500">USD · {sourceLabel}</p>
          {team && <p className="text-xs text-gray-500">{tr('usage.billingUnverified')}</p>}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 content-center">
          {[[tr(`usage.${aiUsage.countKind}`), summary.count?.toLocaleString() ?? '—'], [tr('usage.totalApiTokens'), formatTokens(summary.totalTokens)], [tr('usage.apiInputTokens'), formatTokens(summary.inputTokens)], [tr('usage.apiOutputTokens'), formatTokens(summary.outputTokens)]].map(([label, value]) => <div key={label}><dt className="text-xs text-gray-500">{label}</dt><dd className="mt-1 text-xl font-medium tabular-nums text-gray-300">{value}</dd></div>)}
        </dl>
      </div>
      <details className="text-xs text-gray-500">
        <summary className="cursor-pointer">{tr('usage.dataDetails')}</summary>
        <div className="mt-2 space-y-1">
          {aiUsage.rollup && <p>{tr('usage.rollupDescription')}</p>}
          {aiUsage.rollup && <p>{tr('usage.aggregatedAt', { time: aiUsage.aggregatedAt ?? '—' })}</p>}
          {aiUsage.observedAt && <p>{tr('usage.observedAt', { time: aiUsage.observedAt })}</p>}
        </div>
      </details>
      <p className="text-[12px] text-gray-500">{tr('usage.requestTurnDifference')}</p>
      <ModelUsageSection usage={aiUsage} />
      {teamBalance.remaining !== null && <div className="border-t border-surface-800 pt-4 space-y-3">
        <h2 className="text-[14px] text-gray-300">{tr('usage.teamBalance')}</h2>
        <p className="text-[12px] text-gray-500">{tr('usage.teamBalanceDescription')}</p>
        <div className="grid grid-cols-3 gap-3">
          <SummaryCard label={tr('usage.teamBudgetSpend')} value={formatMoney(teamBalance.spend)} />
          <SummaryCard label={tr('usage.teamBudgetLimit')} value={formatMoney(teamBalance.limit)} />
          <SummaryCard label={tr('usage.remainingBalance')} value={formatMoney(teamBalance.remaining)} />
        </div>
      </div>}
      {aiUsage.rollup ? <p className="text-xs text-gray-500 border-t border-surface-800 pt-3">{tr('usage.rollupBudgetUnsupported')}</p> : <div className="border-t border-surface-800 pt-4 space-y-3">
        <h2 className="text-[14px] text-gray-300">{tr(team ? 'usage.teamBudget' : 'usage.keyBudget')}</h2>
        <p className="text-[12px] text-gray-500">{tr(aiUsage.rollup ? 'usage.rollupBudgetUnsupported' : 'usage.budgetDescription')} · {budgetWindow}</p>
        <div className="grid grid-cols-3 gap-3">
          <SummaryCard label={tr('usage.budgetSpend')} value={formatMoney(budget.spend)} />
          <SummaryCard label={tr('usage.budgetLimit')} value={formatMoney(budget.limit)} />
          <SummaryCard label={tr('usage.remainingBudget')} value={formatMoney(budget.remaining)} />
        </div>
        {pct !== null && <div className="h-1.5 rounded-full bg-surface-950 overflow-hidden"><div className="h-full bg-primary-500" style={{ width: `${pct}%` }} /></div>}
      </div>}
      {team && <section className="border-t border-surface-800 pt-4 space-y-3">
        <h2 className="text-[14px] text-gray-300">{tr('usage.monthlyHistory')}</h2>
        <p className="text-xs text-gray-500">{tr('usage.monthlyHistoryDescription')}</p>
        {aiUsage.monthly?.length ? <div className="overflow-x-auto"><table className="w-full text-sm text-gray-400">
          <thead><tr><th className="text-left py-2">{tr('usage.month')}</th><th className="text-right">{tr('usage.monthlyCost')}</th><th className="text-right">{tr('usage.monthlyRequests')}</th></tr></thead>
          <tbody>{aiUsage.monthly.map(row => <tr key={row.month} className="border-t border-surface-800">
            <td className="py-2">{row.month}</td><td className="text-right tabular-nums">{formatMoney(row.costUsd)}</td>
            <td className="text-right tabular-nums">{row.count === null ? '—' : row.count.toLocaleString()}</td>
          </tr>)}</tbody>
        </table></div> : <p className="text-xs text-gray-500">{tr('usage.monthlyHistoryUnavailable')}</p>}
      </section>}
      {aiUsage.kind !== 'unavailable' && daily.length === 0 && <p className="text-[13px] text-gray-500">{tr('usage.noDailyUsage')}</p>}
      {daily.length > 0 && <>
        <p className="text-[12px] text-gray-500">{aiUsage.dailyWindow ? tr('usage.rollupDailyWindow', { start: aiUsage.dailyWindow.startsOn, end: aiUsage.dailyWindow.endsBefore }) : tr(team ? 'usage.routerDailyWindow' : 'usage.fallbackDailyWindow', { days: aiUsage.days })}</p>
        <details className="text-sm text-gray-400"><summary className="cursor-pointer">{tr('usage.dailyDetails')}</summary>
        <AiTokenLineChart data={daily} isDark={isDark} />
        <div className="overflow-auto max-h-72">
          <table className="w-full text-[13px] text-gray-400 tabular-nums">
            <caption className="text-left mb-2">{tr('usage.dailyDetails')}</caption>
            <thead><tr>{['date', 'apiInputTokens', 'apiOutputTokens', 'totalApiTokens', 'periodCost', aiUsage.countKind].map(key => <th key={key} className="text-right p-2">{tr(`usage.${key}`)}</th>)}</tr></thead>
            <tbody>{daily.map(day => <tr key={day.date}>
              <td className="text-right p-2">{day.date}</td>
              <td className="text-right p-2">{day.inputTokens?.toLocaleString() ?? '—'}</td>
              <td className="text-right p-2">{day.outputTokens?.toLocaleString() ?? '—'}</td>
              <td className="text-right p-2">{day.totalTokens?.toLocaleString() ?? '—'}</td>
              <td className="text-right p-2">{formatMoney(day.costUsd)}</td>
              <td className="text-right p-2">{day.count?.toLocaleString() ?? '—'}</td>
            </tr>)}</tbody>
          </table>
        </div></details>
      </>}
    </section>
  );
}

export function ModelUsageSection({ usage }: { usage: UsageView }) {
  const [expanded, setExpanded] = useState(false);
  const models = usage.models ?? [];
  const visible = expanded ? models : models.slice(0, 5);
  const total = usage.summary.costUsd;
  const sharesValid = total !== null && total > 0 && models.every(m => m.costUsd !== null && m.costUsd >= 0)
    && Math.abs(models.reduce((sum, m) => sum + (m.costUsd ?? 0), 0) - total) <= Math.max(0.000001, total * 0.000001);
  const maximum = Math.max(0, ...models.map(m => m.costUsd ?? 0));
  return <section className="border-t border-surface-800 pt-5 space-y-3" aria-label={tr('usage.modelDailyTitle')}>
    {usage.modelDaily && usage.dailyWindow && (() => {
      const dailyDates = new Set(usage.daily.map(day => day.date));
      const valid = usage.daily.length > 0 && usage.modelDaily.length > 0
        && usage.modelDaily.every(row => Number.isFinite(row.costUsd) && row.costUsd >= 0 && Number.isInteger(row.count) && row.count >= 0 && dailyDates.has(row.date)
        && row.date >= usage.dailyWindow!.startsOn && row.date < usage.dailyWindow!.endsBefore)
        && usage.daily.every(day => day.costUsd !== null && day.costUsd >= 0 && Math.abs(usage.modelDaily!
          .filter(row => row.date === day.date).reduce((sum, row) => sum + row.costUsd, 0) - day.costUsd!) < Math.max(0.000001, Math.abs(day.costUsd!) * 0.000001));
      return <div className="space-y-2">
        <h2 className="text-sm font-medium text-gray-300">{tr('usage.modelDailyTitle')}</h2>
        <p className="text-xs text-gray-500">{tr('usage.modelDailyPeriod', { start: usage.dailyWindow.startsOn, end: usage.dailyWindow.endsBefore })}</p>
        {valid ? <DailyModelCostChart rows={usage.modelDaily} dates={usage.daily.map(day => day.date)} /> : <p role="status" className="text-xs text-gray-500">{tr('usage.modelDailyMismatch')}</p>}
      </div>;
    })()}
    {models.length === 0 && !usage.modelDaily && <p className="text-[13px] text-gray-400">{tr(usage.kind === 'team' ? 'usage.modelsUnavailable' : 'usage.modelsConnectionRequired')}</p>}
    {models.length > 0 && <details className="text-xs text-gray-400"><summary className="cursor-pointer">{tr('usage.modelDetails')} · {tr('usage.modelPeriod')}</summary><p className="text-xs text-gray-500">{tr('usage.recordedCostNote')}</p><div className="overflow-x-auto">
        <table className="w-full text-[13px] text-gray-400 tabular-nums">
          <caption className="sr-only">{tr('usage.modelUsage')}</caption>
          <thead><tr>{['modelName', 'modelCost', 'costShare', 'requests', 'apiInputTokens', 'apiOutputTokens'].map(key =>
            <th key={key} scope="col" className="p-2 text-right first:text-left whitespace-nowrap">{tr(`usage.${key}`)}</th>)}</tr></thead>
          <tbody>{visible.map((model, index) => <tr key={`${model.model}-${index}`} className="border-t border-surface-800">
            <th scope="row" className="p-2 text-left font-normal min-w-40 max-w-72 break-words">{model.model}
              <div aria-hidden="true" className="mt-2 h-1 rounded bg-surface-800"><div className="h-1 rounded bg-primary-500" style={{ width: `${maximum > 0 ? Math.max(0, (model.costUsd ?? 0) / maximum * 100) : 0}%` }} /></div>
            </th>
            <td className="p-2 text-right whitespace-nowrap font-medium">{formatMoney(model.costUsd)}</td>
            <td className="p-2 text-right">{sharesValid ? `${((model.costUsd ?? 0) / total! * 100).toFixed(1)}%` : '—'}</td>
            <td className="p-2 text-right">{model.count?.toLocaleString() ?? '—'}</td>
            <td className="p-2 text-right">{model.inputTokens?.toLocaleString() ?? '—'}</td>
            <td className="p-2 text-right">{model.outputTokens?.toLocaleString() ?? '—'}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {!sharesValid && <p className="text-[12px] text-gray-500">{tr('usage.shareUnavailable')}</p>}
      {models.length > 5 && <button type="button" aria-expanded={expanded} className="text-[13px] text-primary-400 underline underline-offset-4" onClick={() => setExpanded(!expanded)}>{tr(expanded ? 'usage.fewerModels' : 'usage.allModels', { count: models.length })}</button>}
      </details>}
  </section>;
}


function DailyModelCostChart({ rows, dates }: { rows: NonNullable<UsageView['modelDaily']>; dates: string[] }) {
  const [activeDate, setActiveDate] = useState<string | null>(null);
  const tooltipId = useId();
  const detailMoney = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.model, (totals.get(row.model) ?? 0) + row.costUsd);
  const top = [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([model]) => model);
  const labels = [...top, ...(totals.size > 5 ? [tr('usage.otherModels')] : [])];
  const colors = ['#60a5fa', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#94a3b8'];
  const buckets = dates.map(date => {
    const values = labels.map(() => 0);
    const requests = labels.map(() => 0);
    for (const row of rows) if (row.date === date) {
      const i = top.includes(row.model) ? top.indexOf(row.model) : labels.length - 1;
      values[i] += row.costUsd;
      requests[i] += row.count;
    }
    return { date, values, requests, total: values.reduce((sum, value) => sum + value, 0) };
  });
  const max = Math.max(1, ...buckets.map(bucket => bucket.total));
  const width = 720, height = 230, left = 58, right = 12, topPad = 12, bottom = 40;
  const base = height - bottom, chartHeight = base - topPad;
  const slot = (width - left - right) / Math.max(1, dates.length);
  const barWidth = Math.max(2, Math.min(24, slot * 0.72));
  const labelStep = Math.max(1, Math.ceil(dates.length / 8));
  return <div className="space-y-3">
    <div className="relative overflow-x-auto" onMouseLeave={() => setActiveDate(null)}><svg role="img" aria-label={tr('usage.modelDailyChart')} viewBox={`0 0 ${width} ${height}`} className="w-full min-w-[520px] max-h-72 text-gray-400">
      {[0, 0.5, 1].map(tick => <g key={tick}><line x1={left} x2={width - right} y1={base - tick * chartHeight} y2={base - tick * chartHeight} stroke="currentColor" opacity="0.15" /><text x={left - 6} y={base - tick * chartHeight + 4} textAnchor="end" fill="currentColor" fontSize="11">{formatMoney(max * tick)}</text></g>)}
      {buckets.map((bucket, index) => {
        const x = left + slot * (index + 0.5);
        let stacked = 0;
        return <g key={bucket.date}>
          <rect x={left + slot * index} y={topPad} width={slot} height={base - topPad}
            fill="currentColor" opacity={activeDate === bucket.date ? 0.08 : 0} />
          {bucket.values.map((value, i) => {
            const h = value / max * chartHeight;
            const y = base - (stacked + value) / max * chartHeight;
            stacked += value;
            return value > 0 ? <rect key={labels[i]} x={x - barWidth / 2} y={y} width={barWidth} height={h} fill={colors[i]}><title>{bucket.date} · {labels[i]}: {formatMoney(value)} · {bucket.requests[i].toLocaleString()} {tr('usage.requests')} · {tr('usage.dayTotal')} {formatMoney(bucket.total)}</title></rect> : null;
          })}
          {(index % labelStep === 0 || index === dates.length - 1) && <text x={x} y={height - 12} textAnchor="middle" fill="currentColor" fontSize="10">{formatShortDate(bucket.date)}</text>}
          <rect x={left + slot * index} y={topPad} width={slot} height={height - topPad}
            fill="transparent" tabIndex={0} role="button" aria-label={bucket.date}
            aria-describedby={activeDate === bucket.date ? tooltipId : undefined}
            onMouseEnter={() => setActiveDate(bucket.date)} onFocus={() => setActiveDate(bucket.date)}
            onBlur={() => setActiveDate(null)} onClick={() => setActiveDate(bucket.date)}
            onKeyDown={event => { if (event.key === 'Escape') setActiveDate(null); }} />
        </g>;
      })}
    </svg>
      {activeDate && <div id={tooltipId} role="tooltip" className="pointer-events-none absolute top-2 right-2 z-10 max-w-[calc(100%-1rem)] rounded-lg border border-surface-700 bg-surface-900 p-3 text-xs text-gray-200 shadow-lg">
        <div className="mb-2 font-medium">{activeDate} · {tr('usage.dayTotal')} {detailMoney(buckets.find(bucket => bucket.date === activeDate)?.total ?? 0)}</div>
        <div className="max-h-48 overflow-y-auto pointer-events-auto">
          {rows.filter(row => row.date === activeDate).sort((a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model)).map(row => <div key={row.model} className="flex justify-between gap-4 py-1">
            <span className="break-all">{row.model}</span><span className="shrink-0 tabular-nums">{detailMoney(row.costUsd)} · {row.count.toLocaleString()} {tr('usage.requests')}</span>
          </div>)}
          {!rows.some(row => row.date === activeDate) && <div>0 {tr('usage.requests')}</div>}
        </div>
      </div>}
    </div>
    <ul className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-gray-400">{labels.map((label, i) => <li key={label} className="flex items-center gap-2"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: colors[i] }} />{label}: {formatMoney(buckets.reduce((sum, bucket) => sum + bucket.values[i], 0))}</li>)}</ul>
  </div>;
}

function AiTokenLineChart({ data, isDark }: { data: UsageDay[]; isDark: boolean }) {
  const values = data.map(d => d.totalTokens);
  const dates = data.map(d => d.date);
  const maxVal = Math.max(...values.filter((value): value is number => value !== null), 1);
  const palette = isDark
    ? { grid: '#374151', axisText: '#6b7280', line: '#60a5fa', fill: '#60a5fa' }
    : { grid: '#e5e7eb', axisText: '#6b7280', line: '#2563eb', fill: '#2563eb' };
  const width = 900;
  const height = 160;
  const padL = 48;
  const padR = 16;
  const padT = 18;
  const padB = 28;
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;
  const xScale = (i: number) => padL + (i / Math.max(1, dates.length - 1)) * chartW;
  const yScale = (v: number) => padT + chartH - (v / maxVal) * chartH;
  const linePath = values.map((v, i) => v === null ? '' : `${i === 0 || values[i - 1] === null ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(v).toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${xScale(values.length - 1).toFixed(1)},${yScale(0).toFixed(1)} L${xScale(0).toFixed(1)},${yScale(0).toFixed(1)} Z`;
  const xLabelStep = Math.max(1, Math.floor(dates.length / 8));

  return (
    <div className="bg-surface-900 border border-surface-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[13px] text-gray-400 font-medium">{tr('usage.dailyApiTokens')}</div>
        <div className="text-[12px] text-gray-600">{tr('usage.dailyApiTokensSub')}</div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ maxHeight: 180 }}>
        {[0, 0.5, 1].map((r) => {
          const y = padT + chartH - r * chartH;
          return <line key={r} x1={padL} x2={width - padR} y1={y} y2={y} stroke={palette.grid} strokeWidth={0.5} strokeDasharray={r === 0 ? '' : '3,3'} />;
        })}
        {values.every(value => value !== null) && <path d={areaPath} fill={palette.fill} opacity={0.12} />}
        {values.map((value, index) => value === null ? null : <circle key={dates[index]} cx={xScale(index)} cy={yScale(value)} r={2} fill={palette.line}><title>{dates[index]} · {value.toLocaleString()} tokens · {formatMoney(data[index].costUsd)}</title></circle>)}
        <path d={linePath} fill="none" stroke={palette.line} strokeWidth={1.8} strokeLinejoin="round" />
        {dates.map((d, i) => (i % xLabelStep === 0 || i === dates.length - 1) && (
          <text key={d} x={xScale(i)} y={height - 8} textAnchor="middle" fill={palette.axisText} fontSize={9} fontFamily="monospace">
            {formatShortDate(d)}
          </text>
        ))}
        <text x={padL - 6} y={padT + 4} textAnchor="end" fill={palette.axisText} fontSize={9} fontFamily="monospace">{formatTokens(maxVal)}</text>
        <text x={padL - 6} y={padT + chartH + 3} textAnchor="end" fill={palette.axisText} fontSize={9} fontFamily="monospace">0</text>
      </svg>
    </div>
  );
}

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-surface-900 border border-surface-800 rounded-xl p-4">
      <div className="text-[12px] text-gray-500 uppercase tracking-wider">{label}</div>
      <div className="text-3xl font-bold text-gray-100 mt-1 tabular-nums">{value}</div>
      {sub && <div className="text-[13px] text-gray-500 mt-1 truncate" title={sub}>{sub}</div>}
    </div>
  );
}

function LegendCell({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1">
      <div className="w-3 h-3 rounded-sm" style={{ background: color }} />
      <span>{label}</span>
    </div>
  );
}

// ───── Daily total line chart (pure SVG) ─────
function DailyLineChart({ dates, values, isDark }: { dates: string[]; values: number[]; isDark: boolean }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Theme-aware palette
  const palette = isDark
    ? {
        grid: '#374151',
        axisText: '#6b7280',
        line: '#4ade80',
        gradStart: '#4ade80',
        hoverAccent: '#fde047',
        crosshair: '#6b7280',
        tipBg: '#111827',
        tipBorder: '#374151',
        tipText: '#e5e7eb',
      }
    : {
        grid: '#e5e7eb',
        axisText: '#6b7280',
        line: '#16a34a',
        gradStart: '#16a34a',
        hoverAccent: '#d97706',
        crosshair: '#9ca3af',
        tipBg: '#ffffff',
        tipBorder: '#d1d5db',
        tipText: '#111827',
      };

  const width = 900;
  const height = 180;
  const padL = 48;
  const padR = 16;
  const padT = 20;
  const padB = 32;
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;

  const maxVal = Math.max(...values, 1);
  // Y-axis ticks: up to 4 nice ticks
  const yTicks = useMemo(() => {
    const step = Math.ceil(maxVal / 4);
    const ticks: number[] = [];
    for (let v = 0; v <= maxVal; v += step) ticks.push(v);
    if (ticks[ticks.length - 1] < maxVal) ticks.push(maxVal);
    return ticks;
  }, [maxVal]);

  const xScale = (i: number) => padL + (i / Math.max(1, dates.length - 1)) * chartW;
  const yScale = (v: number) => padT + chartH - (v / maxVal) * chartH;

  // Build SVG path
  const linePath = values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(v).toFixed(1)}`)
    .join(' ');

  // Area fill path (line + close at bottom)
  const areaPath = `${linePath} L${xScale(values.length - 1).toFixed(1)},${yScale(0).toFixed(1)} L${xScale(0).toFixed(1)},${yScale(0).toFixed(1)} Z`;

  // X-axis labels — show ~8-10 evenly
  const xLabelStep = Math.max(1, Math.floor(dates.length / 8));

  return (
    <div className="bg-surface-900 border border-surface-800 rounded-xl p-5 mb-4">
      <div className="text-[13px] text-gray-400 mb-2 font-medium">{tr('usage.allProjectsDailyTurns')}</div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ maxHeight: 200 }}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {/* Grid lines */}
        {yTicks.map((v) => (
          <g key={v}>
            <line
              x1={padL} x2={width - padR}
              y1={yScale(v)} y2={yScale(v)}
              stroke={palette.grid} strokeWidth={0.5} strokeDasharray={v === 0 ? '' : '3,3'}
            />
            <text x={padL - 6} y={yScale(v) + 3} textAnchor="end" fill={palette.axisText} fontSize={9} fontFamily="monospace">
              {v}
            </text>
          </g>
        ))}

        {/* Area fill */}
        <path d={areaPath} fill="url(#lineGradient)" opacity={0.3} />

        {/* Gradient def */}
        <defs>
          <linearGradient id="lineGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={palette.gradStart} stopOpacity={0.6} />
            <stop offset="100%" stopColor={palette.gradStart} stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* Line */}
        <path d={linePath} fill="none" stroke={palette.line} strokeWidth={1.8} strokeLinejoin="round" />

        {/* Dots */}
        {values.map((v, i) => (
          <circle
            key={i}
            cx={xScale(i)} cy={yScale(v)}
            r={hoverIdx === i ? 4 : (v > 0 ? 2 : 0)}
            fill={hoverIdx === i ? palette.hoverAccent : palette.line}
            stroke={hoverIdx === i ? palette.hoverAccent : 'none'}
            strokeWidth={2}
          />
        ))}

        {/* Invisible hover targets */}
        {values.map((_v, i) => (
          <rect
            key={`h${i}`}
            x={xScale(i) - chartW / dates.length / 2}
            y={padT}
            width={chartW / dates.length}
            height={chartH}
            fill="transparent"
            onMouseEnter={() => setHoverIdx(i)}
          />
        ))}

        {/* Hover crosshair + label */}
        {hoverIdx !== null && (
          <>
            <line
              x1={xScale(hoverIdx)} x2={xScale(hoverIdx)}
              y1={padT} y2={padT + chartH}
              stroke={palette.crosshair} strokeWidth={0.5} strokeDasharray="3,3"
            />
            <rect
              x={xScale(hoverIdx) - 36} y={yScale(values[hoverIdx]) - 28}
              width={72} height={22} rx={4}
              fill={palette.tipBg} stroke={palette.tipBorder} strokeWidth={0.5}
            />
            <text
              x={xScale(hoverIdx)} y={yScale(values[hoverIdx]) - 14}
              textAnchor="middle" fill={palette.tipText} fontSize={10} fontFamily="monospace"
            >
              {formatShortDate(dates[hoverIdx])} · {values[hoverIdx]}
            </text>
          </>
        )}

        {/* X-axis labels */}
        {dates.map((d, i) => {
          if (i % xLabelStep !== 0 && i !== dates.length - 1) return null;
          return (
            <text key={d} x={xScale(i)} y={height - 6} textAnchor="middle" fill={palette.axisText} fontSize={9} fontFamily="monospace">
              {formatShortDate(d)}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
