import { utcUsageWindow } from '../ai-usage/usage-period.js';
import { resolveLiteLLMCredentials } from './litellm-credentials.js';
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
  accuracy: 'key-window-unverified' | 'key-window-local' | 'unavailable';
  note?: string;
}

interface CurrentVmBudgetReadResult {
  snapshot: AiTokenBudgetSnapshot;
  apiKeyHash?: string;
  teamId?: string | null;
  usageSince?: string | null;
  managementBaseUrl?: string;
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

/**
 * Inference and safe self-service key metadata can be exposed on different
 * listeners. Prefer an explicit management URL. For the managed-fleet legacy
 * topology only, inference port 14003 maps to the same host's key-info port
 * 4000. Other URLs are never rewritten implicitly.
 */
export function resolveLiteLlmManagementBaseUrl(inferenceBaseUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.LITELLM_MANAGEMENT_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '').replace(/\/v1$/, '');

  const normalized = inferenceBaseUrl.replace(/\/$/, '').replace(/\/v1$/, '');
  try {
    const url = new URL(normalized);
    if (url.port === '14003') {
      url.port = '4000';
      return url.toString().replace(/\/$/, '');
    }
  } catch {
    // Let the caller report the malformed configured URL.
  }
  return normalized;
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
    accuracy: source === 'litellm-spend-logs' ? 'key-window-unverified' : source === 'tower-db-metadata' ? 'key-window-local' : 'unavailable',
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

  return {
    days,
    daily,
    totals,
    source,
    accuracy: source === 'litellm-spend-logs' ? 'key-window-unverified' : source === 'tower-db-metadata' ? 'key-window-local' : 'unavailable',
    note,
  };
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
async function readCurrentVmTokenBudgetSnapshot(customer: string, deadline: number): Promise<CurrentVmBudgetReadResult> {
  let connection: { baseUrl: string; apiKey: string };
  try { connection = await resolveLiteLLMCredentials(); }
  catch { return { snapshot: errorSnapshot(customer, 'LiteLLM VM credential is unavailable') }; }
  const { baseUrl, apiKey } = connection;
  const managementBaseUrl = resolveLiteLlmManagementBaseUrl(baseUrl);

  const controller = new AbortController();
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { snapshot: errorSnapshot(customer, 'Usage lookup deadline exceeded') };
  const timeout = setTimeout(() => controller.abort(), remaining);
  try {
    const resp = await fetch(`${managementBaseUrl}/key/info`, {
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
      managementBaseUrl,
      apiKeyHash: typeof payload.key === 'string' ? payload.key : undefined,
      teamId: typeof info.team_id === 'string' ? info.team_id : null,
      // A self-hosted instance may have used another virtual key before installation was
      // corrected. Local DB fallback must not attribute those historical turns
      // to the newly connected key. The key creation timestamp is the earliest
      // defensible boundary available without router-admin credentials.
      usageSince: process.env.LITELLM_USAGE_SINCE
        || (typeof info.created_at === 'string' ? info.created_at : null),
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

async function readLiteLlmSpendLogsUsageSummary(days = 30, apiKeyHash?: string, managementBaseUrl?: string, deadline = Date.now() + 8_000): Promise<AiTokenUsageSummary | null> {
  const safeDays = Math.max(1, Math.min(days, 180));
  // Keep usage on the same resolved VM binding as /key/info, never legacy env.
  const adminBaseUrl = managementBaseUrl;
  const adminKey = liteLlmAdminKey();
  if (!adminBaseUrl || !adminKey || !apiKeyHash) return null;

  const controller = new AbortController();
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  const timeout = setTimeout(() => controller.abort(), remaining);
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

    const now = new Date();
    const window = utcUsageWindow(safeDays, now);
    const cutoff = Date.parse(window.start);
    const until = Date.parse(window.end);
    const byDate: Record<string, AiTokenUsageDay> = {};
    for (const row of payload) {
      if (!row || typeof row !== 'object') continue;
      if (row.api_key !== apiKeyHash) continue;
      if (row.status && row.status !== 'success') continue;
      const start = new Date(row.startTime || row.start_time || row.date || 0);
      if (!Number.isFinite(start.getTime()) || start.getTime() < cutoff || start.getTime() >= until) continue;
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

    const daily = fillDailyUsageBuckets(safeDays, byDate, now);
    return usageSummaryFromDaily(safeDays, daily, 'litellm-spend-logs', 'Tower API ledger filtered by this VM virtual key; legacy endpoint completeness is unverified');
  } finally {
    clearTimeout(timeout);
  }
}

function fillDailyUsageBuckets(days: number, byDate: Record<string, AiTokenUsageDay>, now = new Date()): AiTokenUsageDay[] {
  const daily: AiTokenUsageDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
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

async function readLocalPiTokenUsageSummary(days = 30, usageSince?: string | null): Promise<AiTokenUsageSummary> {
  const safeDays = Math.max(1, Math.min(days, 180));
  const parsedUsageSince = usageSince ? new Date(usageSince) : null;
  const validUsageSince = parsedUsageSince && Number.isFinite(parsedUsageSince.getTime())
    ? parsedUsageSince.toISOString()
    : null;
  const now = new Date();
  const window = utcUsageWindow(safeDays, now);
  const rows = await query<{
    d: string;
    input_tokens: string | number | null;
    output_tokens: string | number | null;
    cache_read_tokens: string | number | null;
    cache_creation_tokens: string | number | null;
    cost_usd: string | number | null;
    turns: string | number | null;
  }>(`
    SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM((metadata->'usage'->>'cache_read_tokens')::numeric), 0) AS cache_read_tokens,
           COALESCE(SUM((metadata->'usage'->>'cache_creation_tokens')::numeric), 0) AS cache_creation_tokens,
           COALESCE(SUM((metadata->'usage'->>'cost_usd')::numeric), 0) AS cost_usd,
           COUNT(*) AS turns
      FROM messages
     WHERE created_at >= $1::timestamptz AND created_at < $3::timestamptz
       AND role = 'assistant'
       -- Only count Tower API usage that Tower can currently attribute to a
       -- provider cost. Claude SDK turns also write input/output tokens, and
       -- may carry a JSON cost_usd key with a null value when cache metrics are
       -- present. Require a non-null cost_usd value so those rows do not mix
       -- with API spend.
       AND NULLIF(metadata->'usage'->>'cost_usd', '') IS NOT NULL
       -- When SpendLogs are unavailable, do not merge turns from the previous
       -- VM key into the usage shown for the current key.
       AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
     GROUP BY to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
     ORDER BY d
  `, [window.start, validUsageSince, window.end]);

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

  const daily = fillDailyUsageBuckets(safeDays, byDate, now);
  return usageSummaryFromDaily(
    safeDays,
    daily,
    'tower-db-metadata',
    validUsageSince
      ? `Fallback: Tower DB message usage metadata since current LiteLLM key creation (${validUsageSince})`
      : 'Fallback: Tower DB message usage metadata; current key start is unknown',
  );
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
  const started = Date.now();
  const deadline = started + 8_000;
  const budgetRead = await readCurrentVmTokenBudgetSnapshot(customer, deadline);
  const budgetFinished = Date.now();
  const remoteUsage = await readLiteLlmSpendLogsUsageSummary(days, budgetRead.apiKeyHash, budgetRead.managementBaseUrl, deadline)
    .catch(() => null);
  const remoteFinished = Date.now();
  const usage = remoteUsage
    || await readLocalPiTokenUsageSummary(days, budgetRead.usageSince).catch(() => emptyUsageSummary(days));
  const finished = Date.now();
  if (finished - started >= 2_000) {
    // Fixed stage names and numeric durations only: no credentials, URLs or provider errors.
    console.warn('[usage-fallback] slow lookup', {
      budgetMs: budgetFinished - started,
      spendLogsMs: remoteFinished - budgetFinished,
      localMs: finished - remoteFinished,
      totalMs: finished - started,
      usedLocalFallback: !remoteUsage,
    });
  }
  return {
    scope: 'current-vm',
    currentCustomer: currentCustomer || undefined,
    rows: [budgetRead.snapshot],
    usage,
  };
}
