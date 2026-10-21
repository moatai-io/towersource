// Router field names follow the self-service usage API's /v1/usage implementation.
// summary is UTC calendar month; daily is a rolling N-day window (first day may be partial).
// budget_window is a separate SpendLogs query, NOT team.spend or the monthly summary.
export interface UsageMetrics {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  count: number | null;
}
export interface UsageDay extends UsageMetrics { date: string }
export interface UsageView {
  kind: 'team' | 'fallback' | 'unavailable';
  freshness?: 'live' | 'stale';
  observedAt?: string;
  days: number;
  models?: Array<UsageMetrics & { model: string }>;
  monthly?: Array<UsageMetrics & { month: string }>;
  modelDaily?: Array<{ date: string; model: string; costUsd: number; count: number }>;
  rollup?: boolean;
  aggregatedAt?: string;
  teamName?: string;
  dailyWindow?: { startsOn: string; endsBefore: string };
  countKind: 'requests' | 'responseRecords';
  fallbackSource?: 'key' | 'local';
  summary: UsageMetrics;
  daily: UsageDay[];
  budget: {
    spend: number | null;
    limit: number | null;
    remaining: number | null;
    startsAt?: string;
    resetsAt?: string;
  };
  teamBalance: {
    spend: number | null;
    limit: number | null;
    remaining: number | null;
  };
  warning?: string;
}
type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
export const numberOrNull = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const timestamp = (value: unknown): string | undefined => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
const emptyMetrics = (): UsageMetrics => ({ inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, count: null });
export const unavailableUsage = (days: number, warning?: string): UsageView => ({
  kind: 'unavailable', days, countKind: 'requests', summary: emptyMetrics(), daily: [],
  budget: { spend: null, limit: null, remaining: null },
  teamBalance: { spend: null, limit: null, remaining: null }, warning,
});
function routerMetrics(row: Row, daily = false): UsageMetrics {
  const inputTokens = numberOrNull(row.input_tokens);
  const outputTokens = numberOrNull(row.output_tokens);
  return {
    inputTokens, outputTokens,
    // The Router daily query has no total_tokens field; cache tokens must not be added again.
    totalTokens: daily ? (inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens) : numberOrNull(row.total_tokens),
    costUsd: numberOrNull(row.cost_usd), count: numberOrNull(row.requests),
  };
}
// The Router omits zero-usage dates. Fill only gaps inside its observed date span;
// never invent leading/trailing full days for its rolling-window contract.
export function fillDailyGaps(rows: UsageDay[]): UsageDay[] {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 2) return sorted;
  const byDate = new Map(sorted.map(row => [row.date, row]));
  const start = Date.parse(`${sorted[0].date}T00:00:00Z`);
  const finish = Date.parse(`${sorted[sorted.length - 1].date}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish - start > 181 * 86400000) return sorted;
  const result: UsageDay[] = [];
  for (let time = start; time <= finish; time += 86400000) {
    const date = new Date(time).toISOString().slice(0, 10);
    result.push(byDate.get(date) ?? { date, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, count: 0 });
  }
  return result;
}
export function routerUsageView(payload: unknown, days: number): UsageView {
  const response = record(payload);
  const usage = record(response.usage);
  if (!['live', 'stale'].includes(String(response.freshness)) || !timestamp(response.observedAt)
    || !['litellm-spendlogs', 'litellm-daily-team-spend'].includes(String(usage.source)) || usage.scope !== 'team'
    || usage.period !== 'calendar_month' || usage.days !== days || !Array.isArray(usage.daily)
    || !usage.summary || typeof usage.summary !== 'object' || Array.isArray(usage.summary)) {
    throw new Error('Invalid Router usage contract');
  }
  const rollup = usage.source === 'litellm-daily-team-spend';
  const dailyWindow = record(usage.daily_window);
  if (rollup && (dailyWindow.timezone !== 'UTC'
    || !/^\d{4}-\d{2}-\d{2}$/.test(String(dailyWindow.starts_on))
    || !/^\d{4}-\d{2}-\d{2}$/.test(String(dailyWindow.ends_before))
    || (Date.parse(String(dailyWindow.ends_before)) - Date.parse(String(dailyWindow.starts_on))) !== days * 86400000)) {
    throw new Error('Invalid Router rollup window contract');
  }
  const window = rollup ? {} : record(usage.budget_window);
  const team = record(usage.team);
  const startsAt = timestamp(window.starts_at);
  const resetsAt = timestamp(window.resets_at);
  // Compare to the observation time, not now: a stale snapshot retains its original window.
  const validWindow = startsAt && resetsAt && Date.parse(startsAt) <= Date.parse(String(response.observedAt))
    && Date.parse(resetsAt) > Date.parse(String(response.observedAt));
  const spend = validWindow ? numberOrNull(window.cost_usd) : null;
  const limit = validWindow ? numberOrNull(window.max_budget) : null;
  const teamSpend = numberOrNull(team.spend);
  const teamLimit = numberOrNull(team.max_budget);
  return {
    monthly: Array.isArray(usage.monthly) ? usage.monthly.map(record)
      .filter(row => typeof row.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(row.month))
      .map(row => ({ month: String(row.month), ...routerMetrics(row) }))
      .sort((a, b) => b.month.localeCompare(a.month)) : undefined,
    kind: 'team', freshness: response.freshness as 'live' | 'stale', observedAt: String(response.observedAt),
    models: Array.isArray(usage.models) ? usage.models.map(record).map(row => ({ model: typeof row.model === 'string' ? row.model : 'unknown', ...routerMetrics(row) })).sort((a, b) => (b.costUsd ?? -Infinity) - (a.costUsd ?? -Infinity)) : undefined,
    modelDaily: rollup && Array.isArray(usage.model_daily) && Array.isArray(usage.models)
      && usage.model_daily.every((value) => {
        const row = record(value);
        return typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date)
          && typeof row.model === 'string' && numberOrNull(row.cost_usd) !== null
          && numberOrNull(row.requests) !== null;
      }) ? usage.model_daily.map((value) => {
        const row = record(value);
        return { date: row.date as string, model: row.model as string, costUsd: row.cost_usd as number, count: row.requests as number };
      }) : undefined,
    rollup, aggregatedAt: timestamp(record(usage.summary).aggregated_at),
    teamName: typeof team.team_alias === 'string' ? String(team.team_alias) : undefined,
    dailyWindow: rollup ? { startsOn: String(dailyWindow.starts_on), endsBefore: String(dailyWindow.ends_before) } : undefined,
    days, countKind: 'requests', summary: routerMetrics(record(usage.summary)),
    daily: fillDailyGaps(usage.daily.map(record).filter(row => typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date))
      .map(row => ({ date: row.date as string, ...routerMetrics(row, true) }))),
    budget: { spend, limit, remaining: spend !== null && limit !== null ? limit - spend : null,
      startsAt: validWindow ? startsAt : undefined, resetsAt: validWindow ? resetsAt : undefined },
    teamBalance: {
      spend: teamSpend,
      limit: teamLimit,
      remaining: teamSpend !== null && teamLimit !== null ? teamLimit - teamSpend : null,
    },
  };
}
export function fallbackUsageView(payload: unknown, days: number, warning: string): UsageView {
  const response = record(payload);
  const usage = record(response.usage);
  const keySource = usage.source === 'litellm-spend-logs';
  const localSource = usage.source === 'tower-db-metadata';
  if ((!keySource && !localSource) || usage.accuracy === 'unavailable') return unavailableUsage(days, warning);
  const metrics = (row: Row): UsageMetrics => ({
    inputTokens: numberOrNull(row.inputTokens), outputTokens: numberOrNull(row.outputTokens),
    totalTokens: numberOrNull(row.totalTokens), costUsd: numberOrNull(row.costUsd), count: numberOrNull(row.turns),
  });
  const budget = record(Array.isArray(response.rows) ? response.rows[0] : undefined);
  const spend = budget.ok === true ? numberOrNull(budget.spend) : null;
  const limit = budget.ok === true ? numberOrNull(budget.maxBudget) : null;
  return {
    kind: 'fallback', days, fallbackSource: keySource ? 'key' : 'local',
    observedAt: timestamp(response.capturedAt), countKind: keySource ? 'requests' : 'responseRecords',
    summary: metrics(record(usage.totals)),
    daily: Array.isArray(usage.daily) ? usage.daily.map(record)
      .filter(row => typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date))
      .map(row => ({ date: row.date as string, ...metrics(row) })) : [],
    budget: { spend, limit, remaining: spend !== null && limit !== null ? limit - spend : null,
      resetsAt: timestamp(budget.budgetResetAt) },
    teamBalance: { spend: null, limit: null, remaining: null }, warning,
  };
}
export async function fetchUsageView(days: number, headers: HeadersInit, signal: AbortSignal): Promise<UsageView> {
  let warning: string;
  try {
    const response = await fetch(`/api/metrics/router-ai-usage?scope=team&period=calendar_month&days=${days}`, { headers, signal });
    if (!response.ok) throw new Error(`Router HTTP ${response.status}`);
    return routerUsageView(await response.json(), days);
  } catch (error) {
    if (signal.aborted) throw error;
    warning = error instanceof Error ? error.message : 'Router unavailable';
  }
  try {
    const response = await fetch(`/api/metrics/ai-usage?days=${days}`, { headers, signal });
    if (!response.ok) throw new Error(`Fallback HTTP ${response.status}`);
    return fallbackUsageView(await response.json(), days, warning);
  } catch (error) {
    if (signal.aborted) throw error;
    return unavailableUsage(days, `${warning} · ${error instanceof Error ? error.message : 'Fallback unavailable'}`);
  }
}

export function activityStats(data: {
  dates: string[]; dailyTotals: number[]; grandTotal: number;
  projects: Array<{ name: string; values: number[] }>;
}) {
  let peakValue = 0;
  let peakProject = '';
  let peakDate = '';
  for (const project of data.projects) project.values.forEach((value, index) => {
    if (value > peakValue) { peakValue = value; peakProject = project.name; peakDate = data.dates[index]; }
  });
  let hottestDayIndex = -1;
  data.dailyTotals.forEach((value, index) => {
    if (value > 0 && (hottestDayIndex < 0 || value > data.dailyTotals[hottestDayIndex])) hottestDayIndex = index;
  });
  return {
    peakValue, peakProject, peakDate,
    activeDaysOverall: data.dailyTotals.filter(value => value > 0).length,
    hottestDay: { date: data.dates[hottestDayIndex] || '', value: data.dailyTotals[hottestDayIndex] || 0 },
    avgPerDay: data.grandTotal / Math.max(1, data.dates.length),
  };
}
