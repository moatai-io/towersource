/**
 * Owns: AI token budget snapshots for admin dashboards.
 * Public API: listAiTokenBudgetSnapshots(). See decisions/2026-05-31-pi-utility-model-and-customer-litellm-keys.md.
 */

import { config } from '../../config.js';
import { query } from '../../db/pg-repo.js';

export interface AiTokenBudgetSnapshot {
  customer: string;
  ok: boolean;
  models?: string[];
  maxBudget?: number | null;
  budgetDuration?: string | null;
  budgetResetAt?: string | null;
  spend?: number | null;
  remaining?: number | null;
  usedPct?: number | null;
  metadata?: Record<string, unknown> | null;
  updatedAt: string;
  error?: string;
}

export interface AiTokenUsageDay {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number;
  turns: number;
}

export interface AiTokenUsageSummary {
  days: number;
  daily: AiTokenUsageDay[];
  totals: Omit<AiTokenUsageDay, 'date'>;
  source: 'litellm-spend-logs' | 'tower-db-metadata' | 'unavailable';
  note?: string;
}

interface CurrentVmBudgetReadResult {
  snapshot: AiTokenBudgetSnapshot;
  apiKeyHash?: string;
  teamId?: string | null;
}

export interface AiTokenBudgetListResult {
  rows: AiTokenBudgetSnapshot[];
  scope: 'current-vm';
  currentCustomer?: string;
  usage: AiTokenUsageSummary;
}

/**
 * Derive the customer/VM slug from a managed Tower public URL.
 *
 * Examples:
 * - https://demo-server.tower.example.com → demo-server
 * - https://demo-org.tower.example.com  → demo-org
 */
export function deriveCustomerNameFromPublicUrl(publicUrl: string | undefined | null): string | null {
  if (!publicUrl) return null;
  try {
    const hostname = new URL(publicUrl).hostname.toLowerCase();
    const first = hostname.split('.')[0]?.trim();
    return first || null;
  } catch {
    return null;
  }
}

/**
 * Budget identity for this Tower VM. Explicit env wins, PUBLIC_URL hostname is
 * the fleet convention fallback. Tower's dashboard intentionally shows only the
 * current VM; fleet-wide budget review belongs in the LiteLLM admin UI.
 */
export function resolveCurrentBudgetCustomer(env: NodeJS.ProcessEnv = process.env, publicUrl = config.publicUrl): string | null {
  return (
    env.AI_TOKEN_BUDGET_CUSTOMER ||
    env.TOWER_CUSTOMER_NAME ||
    env.CUSTOMER_NAME ||
    deriveCustomerNameFromPublicUrl(publicUrl)
  )?.trim() || null;
}

function snapshotFromLiteLlmInfo(customer: string, info: Record<string, any>): AiTokenBudgetSnapshot {
  const maxBudget = info.max_budget ?? null;
  const spend = info.spend ?? null;
  let remaining: number | null = null;
  let usedPct: number | null = null;

  try {
    if (maxBudget !== null && spend !== null) {
      remaining = Number(maxBudget) - Number(spend);
      usedPct = Number(maxBudget) > 0 ? (Number(spend) / Number(maxBudget)) * 100 : null;
    }
  } catch {
    remaining = null;
    usedPct = null;
  }

  return {
    customer,
    ok: true,
    models: Array.isArray(info.models) ? info.models : undefined,
    maxBudget,
    budgetDuration: info.budget_duration ?? null,
    budgetResetAt: info.budget_reset_at ?? null,
    spend,
    remaining,
    usedPct,
    metadata: info.metadata ?? null,
    updatedAt: new Date().toISOString(),
  };
}

function emptyUsageSummary(days = 30, source: AiTokenUsageSummary['source'] = 'unavailable', note?: string): AiTokenUsageSummary {
  return {
    days,
    daily: [],
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      turns: 0,
    },
    source,
    note,
  };
}

function usageSummaryFromDaily(days: number, daily: AiTokenUsageDay[], source: AiTokenUsageSummary['source'], note?: string): AiTokenUsageSummary {
  const totals = daily.reduce((acc, day) => {
    acc.inputTokens += day.inputTokens;
    acc.outputTokens += day.outputTokens;
    acc.cacheReadTokens += day.cacheReadTokens;
    acc.cacheCreationTokens += day.cacheCreationTokens;
    acc.totalTokens += day.totalTokens;
    acc.costUsd += day.costUsd;
    acc.turns += day.turns;
    return acc;
  }, emptyUsageSummary(days).totals);

  return { days, daily, totals, source, note };
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function errorSnapshot(customer: string, error: string): AiTokenBudgetSnapshot {
  return {
    customer,
    ok: false,
    updatedAt: new Date().toISOString(),
    error,
  };
}

/**
 * Query the AI router with THIS VM's own virtual key and return only that key's
 * safe /key/info fields. The key is read from process env but is never returned,
 * logged, or written to stdout.
 */
async function readCurrentVmTokenBudgetSnapshot(customer: string): Promise<CurrentVmBudgetReadResult> {
  const baseUrl = (process.env.LITELLM_BASE_URL || '').replace(/\/$/, '');
  // Runtime model calls use /v1 endpoints, while LiteLLM admin endpoints live at root.
  const adminBaseUrl = baseUrl.replace(/\/v1$/, '');
  const apiKey = process.env.LITELLM_API_KEY || '';
  if (!baseUrl || !apiKey) {
    return { snapshot: errorSnapshot(customer, 'LITELLM_BASE_URL or LITELLM_API_KEY is not configured') };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const resp = await fetch(`${adminBaseUrl}/key/info`, {
      method: 'GET',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const text = await resp.text();
    if (!resp.ok) {
      return { snapshot: errorSnapshot(customer, `LiteLLM /key/info failed: HTTP ${resp.status}`) };
    }
    const payload = text ? JSON.parse(text) : {};
    const info = payload.info || payload;
    if (!info || typeof info !== 'object') {
      return { snapshot: errorSnapshot(customer, 'LiteLLM /key/info returned no key info') };
    }
    return {
      snapshot: snapshotFromLiteLlmInfo(customer, info),
      apiKeyHash: typeof payload.key === 'string' ? payload.key : undefined,
      teamId: typeof info.team_id === 'string' ? info.team_id : null,
    };
  } catch (err: any) {
    return { snapshot: errorSnapshot(customer, err?.name === 'AbortError' ? 'LiteLLM /key/info timed out' : (err?.message || 'failed to read current VM token budget')) };
  } finally {
    clearTimeout(timeout);
  }
}

function liteLlmAdminKey(): string {
  return process.env.LITELLM_ADMIN_API_KEY || process.env.LITELLM_MASTER_KEY || '';
}

function extractCacheReadTokensFromSpendLog(row: Record<string, any>): number {
  const details = row.metadata?.usage_object?.prompt_tokens_details;
  return toNumber(details?.cached_tokens ?? details?.cache_read_tokens ?? row.metadata?.cache_read_input_tokens);
}

async function readLiteLlmSpendLogsUsageSummary(days = 30, apiKeyHash?: string): Promise<AiTokenUsageSummary | null> {
  const safeDays = Math.max(1, Math.min(days, 180));
  const baseUrl = (process.env.LITELLM_BASE_URL || '').replace(/\/$/, '');
  const adminBaseUrl = baseUrl.replace(/\/v1$/, '');
  const adminKey = liteLlmAdminKey();
  if (!adminBaseUrl || !adminKey || !apiKeyHash) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const url = new URL(`${adminBaseUrl}/spend/logs`);
    url.searchParams.set('api_key', apiKeyHash);
    const resp = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`LiteLLM /spend/logs failed: HTTP ${resp.status}`);
    }
    const payload = text ? JSON.parse(text) : [];
    if (!Array.isArray(payload)) {
      throw new Error('LiteLLM /spend/logs returned non-array payload');
    }

    const cutoff = Date.now() - safeDays * 24 * 60 * 60 * 1000;
    const byDate: Record<string, AiTokenUsageDay> = {};
    for (const row of payload) {
      if (!row || typeof row !== 'object') continue;
      if (row.api_key !== apiKeyHash) continue;
      if (row.status && row.status !== 'success') continue;
      const start = new Date(row.startTime || row.start_time || row.date || 0);
      if (!Number.isFinite(start.getTime()) || start.getTime() < cutoff) continue;
      const date = start.toISOString().slice(0, 10);
      const inputTokens = toNumber(row.prompt_tokens);
      const outputTokens = toNumber(row.completion_tokens);
      const cacheReadTokens = extractCacheReadTokensFromSpendLog(row);
      const bucket = byDate[date] || {
        date,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        turns: 0,
      };
      bucket.inputTokens += inputTokens;
      bucket.outputTokens += outputTokens;
      bucket.cacheReadTokens += cacheReadTokens;
      bucket.totalTokens += inputTokens + outputTokens;
      bucket.costUsd += toNumber(row.spend);
      bucket.turns += 1;
      byDate[date] = bucket;
    }

    const daily = fillDailyUsageBuckets(safeDays, byDate);
    return usageSummaryFromDaily(safeDays, daily, 'litellm-spend-logs', 'Tower API ledger filtered by this VM virtual key');
  } finally {
    clearTimeout(timeout);
  }
}

function fillDailyUsageBuckets(days: number, byDate: Record<string, AiTokenUsageDay>): AiTokenUsageDay[] {
  const daily: AiTokenUsageDay[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    daily.push(byDate[key] || {
      date: key,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      turns: 0,
    });
  }
  return daily;
}

async function readLocalPiTokenUsageSummary(days = 30): Promise<AiTokenUsageSummary> {
  const safeDays = Math.max(1, Math.min(days, 180));
  const rows = await query<{
    d: string;
    input_tokens: string | number | null;
    output_tokens: string | number | null;
    cache_read_tokens: string | number | null;
    cache_creation_tokens: string | number | null;
    cost_usd: string | number | null;
    turns: string | number | null;
  }>(`
    SELECT to_char(DATE(created_at), 'YYYY-MM-DD') AS d,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM((metadata->'usage'->>'cache_read_tokens')::numeric), 0) AS cache_read_tokens,
           COALESCE(SUM((metadata->'usage'->>'cache_creation_tokens')::numeric), 0) AS cache_creation_tokens,
           COALESCE(SUM((metadata->'usage'->>'cost_usd')::numeric), 0) AS cost_usd,
           COUNT(*) AS turns
      FROM messages
     WHERE created_at >= NOW() - ($1 || ' days')::interval
       AND role = 'assistant'
       -- Only count Tower API usage that Tower can currently attribute to a
       -- provider cost. Claude SDK turns also write input/output tokens, and
       -- may carry a JSON cost_usd key with a null value when cache metrics are
       -- present. Require a non-null cost_usd value so those rows do not mix
       -- with API spend.
       AND NULLIF(metadata->'usage'->>'cost_usd', '') IS NOT NULL
     GROUP BY DATE(created_at)
     ORDER BY DATE(created_at)
  `, [String(safeDays)]);

  const byDate: Record<string, AiTokenUsageDay> = {};
  for (const row of rows) {
    const inputTokens = toNumber(row.input_tokens);
    const outputTokens = toNumber(row.output_tokens);
    const cacheReadTokens = toNumber(row.cache_read_tokens);
    const cacheCreationTokens = toNumber(row.cache_creation_tokens);
    byDate[row.d] = {
      date: row.d,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd: toNumber(row.cost_usd),
      turns: toNumber(row.turns),
    };
  }

  const daily = fillDailyUsageBuckets(safeDays, byDate);
  return usageSummaryFromDaily(safeDays, daily, 'tower-db-metadata', 'Fallback: Tower DB message usage metadata');
}

/**
 * List AI token budget + token usage for this VM only.
 *
 * Fleet-wide budget review should happen in the LiteLLM admin page, not inside
 * each Tower VM's admin surface.
 */
export async function listAiTokenBudgetSnapshots(days = 30): Promise<AiTokenBudgetListResult> {
  const currentCustomer = resolveCurrentBudgetCustomer();
  const customer = currentCustomer || 'current-vm';
  const budgetRead = await readCurrentVmTokenBudgetSnapshot(customer);
  const usage = await readLiteLlmSpendLogsUsageSummary(days, budgetRead.apiKeyHash)
    .catch((err: any) => emptyUsageSummary(days, 'unavailable', err?.message || 'failed to read LiteLLM SpendLogs'))
    || await readLocalPiTokenUsageSummary(days).catch(() => emptyUsageSummary(days));
  return {
    scope: 'current-vm',
    currentCustomer: currentCustomer || undefined,
    rows: [budgetRead.snapshot],
    usage,
  };
}
