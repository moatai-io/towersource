// Owns: read-only customer-scoped usage fetch from the LiteLLM usage sidecar.
// The virtual key is sent only as bearer auth; callers cannot choose another key/team.

import { createHash } from 'node:crypto';
import { resolveLiteLLMCredentials } from '../ai/litellm-credentials.js';

export type LiteLLMUsageScope = 'key' | 'team';
export type LiteLLMUsagePeriod = 'lifetime' | 'calendar_month';

export type LiteLLMSelfServiceUsage = {
  source: 'litellm-spendlogs' | 'litellm-daily-team-spend';
  scope: LiteLLMUsageScope;
  period: LiteLLMUsagePeriod;
  days: number;
  key: Record<string, unknown>;
  team: Record<string, unknown>;
  summary: Record<string, unknown>;
  budget_observation?: {source:'litellm-team-budget';spend_usd:unknown;observed_at:string}|null;
  budget_window: Record<string, unknown> | null;
  daily: Array<Record<string, unknown>>;
  models: Array<Record<string, unknown>>;
  model_daily?: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
};

function usageBaseUrl(routerBaseUrl: string): string {
  const explicit = process.env.LITELLM_USAGE_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  return routerBaseUrl.replace(/\/v1\/?$/, '') + '/usage-self-service';
}

export async function liteLLMUsageIdentity(): Promise<string> {
  const { baseUrl, apiKey } = await resolveLiteLLMCredentials();
  return createHash('sha256').update(usageBaseUrl(baseUrl)).update('\0').update(apiKey).digest('hex');
}

export async function fetchLiteLLMSelfServiceUsage(input: {
  scope?: LiteLLMUsageScope;
  period?: LiteLLMUsagePeriod;
  days?: number;
  signal?: AbortSignal;
} = {}): Promise<LiteLLMSelfServiceUsage> {
  const { baseUrl, apiKey } = await resolveLiteLLMCredentials();
  const scope = input.scope ?? 'team';
  const period = input.period ?? 'calendar_month';
  const days = Math.max(1, Math.min(Math.trunc(input.days ?? 30), 180));
  const url = new URL(`${usageBaseUrl(baseUrl)}/v1/usage`);
  url.searchParams.set('scope', scope);
  url.searchParams.set('period', period);
  url.searchParams.set('days', String(days));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: input.signal ?? AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`LiteLLM usage API returned HTTP ${response.status}`);
  const body = await response.json() as LiteLLMSelfServiceUsage;
  if (!['litellm-spendlogs', 'litellm-daily-team-spend'].includes(body?.source) || body?.scope !== scope
    || body?.period !== period || body?.days !== days
    || !body.summary || typeof body.summary !== 'object' || Array.isArray(body.summary)
    || !Array.isArray(body.daily) || !Array.isArray(body.models) || !Array.isArray(body.projects)) {
    throw new Error('LiteLLM usage API returned an invalid scope contract');
  }
  return body;
}
