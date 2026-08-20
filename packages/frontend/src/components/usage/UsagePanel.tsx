import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { useSettingsStore } from '../../stores/settings-store';

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

interface AiBudgetSnapshot {
  customer: string;
  ok: boolean;
  models?: string[];
  maxBudget?: number | null;
  budgetDuration?: string | null;
  budgetResetAt?: string | null;
  spend?: number | null;
  remaining?: number | null;
  usedPct?: number | null;
  updatedAt: string;
  error?: string;
}

interface AiUsageDay {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number;
  turns: number;
}

interface AiUsageResponse {
  rows: AiBudgetSnapshot[];
  usage: {
    days: number;
    daily: AiUsageDay[];
    totals: Omit<AiUsageDay, 'date'>;
    source?: 'litellm-spend-logs' | 'tower-db-metadata' | 'unavailable';
    note?: string;
  };
  capturedAt: string;
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
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 0 : 2 })}`;
}

function formatTokens(value: number | null | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function formatBudgetWindow(budget: AiBudgetSnapshot | undefined): string {
  if (!budget?.ok) return tr('usage.budgetUnavailable');
  const parts: string[] = [];
  if (budget.budgetDuration) parts.push(tr('usage.budgetDuration', { duration: budget.budgetDuration }));
  if (budget.budgetResetAt) {
    const reset = new Date(budget.budgetResetAt);
    if (!Number.isNaN(reset.getTime())) parts.push(tr('usage.budgetReset', { date: reset.toISOString().slice(0, 10) }));
  }
  return parts.join(' · ') || tr('usage.currentBudgetWindow');
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
  const [aiUsage, setAiUsage] = useState<AiUsageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<{ project: string; date: string; value: number; x: number; y: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('token');
      const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
      const [heatmapRes, aiRes] = await Promise.all([
        fetch(`/api/metrics/usage-heatmap?days=${days}&top=${top}`, { headers }),
        fetch(`/api/metrics/ai-usage?days=${days}`, { headers }),
      ]);
      if (!heatmapRes.ok) throw new Error(`usage heatmap HTTP ${heatmapRes.status}`);
      const json: HeatmapResponse = await heatmapRes.json();
      setData(json);
      if (aiRes.ok) {
        setAiUsage(await aiRes.json());
      } else {
        setAiUsage(null);
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [days, top]);

  useEffect(() => {
    load();
  }, [load]);

  // ───── Derived stats ─────
  const stats = useMemo(() => {
    if (!data) return null;
    let peakValue = 0;
    let peakProject = '';
    let peakDate = '';
    let activeDaysOverall = 0;
    const dayTotals = new Array(data.dates.length).fill(0);

    for (const p of data.projects) {
      p.values.forEach((v, i) => {
        dayTotals[i] += v;
        if (v > peakValue) {
          peakValue = v;
          peakProject = p.name;
          peakDate = data.dates[i];
        }
      });
    }
    activeDaysOverall = dayTotals.filter((v) => v > 0).length;

    let hottestDayIdx = 0;
    let hottestDayVal = 0;
    dayTotals.forEach((v, i) => {
      if (v > hottestDayVal) {
        hottestDayVal = v;
        hottestDayIdx = i;
      }
    });

    return {
      peakValue,
      peakProject,
      peakDate,
      activeDaysOverall,
      hottestDay: { date: data.dates[hottestDayIdx], value: hottestDayVal },
      avgPerDay: data.grandTotal / Math.max(1, data.dates.length),
    };
  }, [data]);

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
            <h1 className="text-2xl font-bold text-gray-100">Usage</h1>
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
        {aiUsage && (
          <AiUsageSection aiUsage={aiUsage} isDark={isDark} />
        )}

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

        {/* ── Daily total line chart ── */}
        {data && data.dailyTotals && data.dailyTotals.length > 0 && (
          <DailyLineChart dates={data.dates} values={data.dailyTotals} isDark={isDark} />
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

function AiUsageSection({ aiUsage, isDark }: { aiUsage: AiUsageResponse; isDark: boolean }) {
  const budget = aiUsage.rows?.[0];
  const totals = aiUsage.usage?.totals;
  const daily = aiUsage.usage?.daily || [];
  const budgetPct = budget && typeof budget.usedPct === 'number' && Number.isFinite(budget.usedPct)
    ? Math.max(0, Math.min(100, budget.usedPct))
    : null;
  const budgetColor = !budget?.ok ? 'tone-danger tone-bg' : budgetPct == null ? 'bg-gray-500' : budgetPct >= 90 ? 'tone-danger tone-bg' : budgetPct >= 70 ? 'tone-warning tone-bg' : 'tone-success tone-bg';
  const usageSourceLabel = aiUsage.usage?.source === 'litellm-spend-logs'
    ? 'Tower API ledger'
    : aiUsage.usage?.source === 'tower-db-metadata'
      ? 'Tower DB fallback'
      : 'usage unavailable';

  return (
    <div className="mb-6 space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <SummaryCard label={tr('usage.apiInputTokens')} value={formatTokens(totals?.inputTokens)} sub={usageSourceLabel} />
        <SummaryCard label={tr('usage.apiOutputTokens')} value={formatTokens(totals?.outputTokens)} sub={usageSourceLabel} />
        <SummaryCard label={tr('usage.cacheReads')} value={formatTokens(totals?.cacheReadTokens)} sub={usageSourceLabel} />
        <SummaryCard label={tr('usage.budgetSpend')} value={formatMoney(budget?.spend)} sub={formatBudgetWindow(budget)} />
        <SummaryCard label={tr('usage.remainingBudget')} value={formatMoney(budget?.remaining)} sub={formatBudgetWindow(budget)} />
      </div>

      {daily.length > 0 && (
        <AiTokenLineChart data={daily} isDark={isDark} />
      )}

      <div className="bg-surface-900 border border-surface-800 rounded-xl p-4">
        <div className="flex items-center gap-3">
          <span className={`w-2 h-2 rounded-full ${budgetColor}`} />
          <div className="flex-1 min-w-0">
            <div className="text-[14px] text-gray-300 font-medium">{tr('usage.budgetRemainingTitle', { customer: budget?.customer || 'current VM' })}</div>
            <div className="text-[12px] text-gray-600 mt-0.5">
              {tr('usage.budgetDescription')} {tr('usage.periodDescription', { source: usageSourceLabel })}{aiUsage.usage?.note ? ` · ${aiUsage.usage.note}` : ''}.
            </div>
          </div>
          {budget?.ok ? (
            <div className="text-right shrink-0">
              <div className="text-[15px] text-gray-100 font-semibold">{formatMoney(budget.spend)} / {formatMoney(budget.maxBudget)}</div>
              <div className="text-[13px] text-gray-500">remaining {formatMoney(budget.remaining)}</div>
            </div>
          ) : (
            <div className="text-[14px] text-red-300 max-w-[320px] truncate" title={budget?.error}>{budget?.error || 'budget unavailable'}</div>
          )}
        </div>
        {budget?.ok && budgetPct != null && (
          <div className="mt-3 h-1.5 rounded-full bg-surface-950 overflow-hidden">
            <div className={`h-full ${budgetColor}`} style={{ width: `${budgetPct}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}

function AiTokenLineChart({ data, isDark }: { data: AiUsageDay[]; isDark: boolean }) {
  const values = data.map(d => d.totalTokens);
  const dates = data.map(d => d.date);
  const maxVal = Math.max(...values, 1);
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
  const linePath = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(v).toFixed(1)}`).join(' ');
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
        <path d={areaPath} fill={palette.fill} opacity={0.12} />
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
