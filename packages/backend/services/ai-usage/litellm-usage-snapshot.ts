// Process-local, bounded last-known canonical snapshots. Never store a virtual key or token hash.
import type { LiteLLMSelfServiceUsage, LiteLLMUsagePeriod, LiteLLMUsageScope } from './litellm-usage-client.js';

export type UsageRequest = { identity: string; scope: LiteLLMUsageScope; period: LiteLLMUsagePeriod; days: number };
export type UsageResult = { freshness: 'live' | 'stale'; observedAt: string; usage: LiteLLMSelfServiceUsage };

const MAX_ENTRIES = 24;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FRESH_MS = 30_000;
let generation = 0;
const pending = new Map<string, Promise<UsageResult | null>>();
const entries = new Map<string, UsageResult>();

function key(request: UsageRequest): string {
  return `${request.identity}:${request.scope}:${request.period}:${request.days}`;
}

export async function readRouterUsage(
  request: UsageRequest,
  fetchUsage: (request: UsageRequest) => Promise<LiteLLMSelfServiceUsage>,
  now = () => Date.now(),
): Promise<UsageResult | null> {
  const id = key(request);
  const cached = entries.get(id);
  const age = cached ? now() - Date.parse(cached.observedAt) : Infinity;
  if (cached && age >= 0 && age < FRESH_MS) return cached;
  const existing = pending.get(id);
  if (existing) return existing;
  const epoch = generation;
  // Defer execution so even a synchronously throwing adapter is registered first.
  const task = Promise.resolve().then(async (): Promise<UsageResult | null> => {
    try {
      const usage = await fetchUsage(request);
      if (epoch !== generation) return null;
      if (!['litellm-spendlogs', 'litellm-daily-team-spend'].includes(usage.source) || usage.scope !== request.scope
        || usage.period !== request.period || usage.days !== request.days) {
        throw new Error('Router usage response does not match requested boundary');
      }
      const result: UsageResult = { freshness: 'live', observedAt: new Date(now()).toISOString(), usage };
      entries.delete(id);
      entries.set(id, result);
      while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
      return result;
    } catch {
      if (epoch !== generation) return null;
      const prior = entries.get(id);
      if (!prior) return null;
      if (now() - Date.parse(prior.observedAt) > MAX_AGE_MS) {
        entries.delete(id);
        return null;
      }
      return { ...prior, freshness: 'stale' };
    }
  });
  // Keep bookkeeping bounded; evicted work still completes for its own callers.
  pending.set(id, task);
  while (pending.size > MAX_ENTRIES) pending.delete(pending.keys().next().value!);
  try {
    return await task;
  } finally {
    if (pending.get(id) === task) pending.delete(id);
  }
}

/** Invalidating on credential changes prevents a previous VM key's Team data being served. */
export function clearRouterUsageSnapshots(): void {
  generation++;
  entries.clear();
  pending.clear();
}
