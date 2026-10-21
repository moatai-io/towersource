export function newerContextSnapshot(previous: unknown, next: unknown): unknown {
  const time = (v: any) => typeof v?.capturedAt === 'string' ? Date.parse(v.capturedAt) : NaN;
  const nextTime = time(next);
  if (!Number.isFinite(nextTime)) return previous;
  const previousTime = time(previous);
  return Number.isFinite(previousTime) && previousTime > nextTime ? previous : next;
}
export interface ContextPressure {
  tokens: number;
  thresholdTokens: number;
  policy: 'tower-pre-prompt';
  source: 'projection' | 'usage-or-transcript';
  observedAt: number;
}
export function normalizeContextPressure(snapshot: any): ContextPressure | undefined {
  const p = snapshot?.pressure;
  if (!p || p.policy !== 'tower-pre-prompt' || !['projection', 'usage-or-transcript'].includes(p.source)) return;
  if (![p.tokens, p.thresholdTokens, p.observedAt].every(v => typeof v === 'number' && Number.isFinite(v) && v > 0)) return;
  if (typeof snapshot.windowTokens !== 'number' || !Number.isFinite(snapshot.windowTokens)
    || p.thresholdTokens > snapshot.windowTokens) return;
  return { tokens: p.tokens, thresholdTokens: p.thresholdTokens, policy: p.policy, source: p.source, observedAt: p.observedAt };
}
import { resolveContextMetric } from './context-metric';

export interface ContextMeasurement {
  requestId: string;
  inputTokens: number;
  windowTokens?: number;
  compactThresholdTokens?: number;
  source: 'provider' | 'estimate' | 'post-compaction-estimate';
  measuredAt: number;
}

const positive = (n: unknown): number => Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : 0;

/** Normalize live or persisted usage once. Explicit context is already cache-inclusive. */
export function normalizeContextMeasurement(input: {
  requestId: string; measuredAt: number; actual?: unknown; estimated?: unknown;
  compactThreshold?: unknown; window?: unknown; compacted?: boolean; uncached?: unknown; cacheRead?: unknown; cacheWrite?: unknown;
}): ContextMeasurement | undefined {
  const actual = positive(input.actual) || (positive(input.uncached) + positive(input.cacheRead) + positive(input.cacheWrite));
  const metric = resolveContextMetric({ actual, estimated: positive(input.estimated), compacted: input.compacted });
  if (!metric.tokens) return undefined;
  return {
    requestId: input.requestId, measuredAt: input.measuredAt,
    inputTokens: metric.tokens, windowTokens: positive(input.window) || undefined,
    compactThresholdTokens: positive(input.compactThreshold) || undefined,
    source: metric.isEstimated ? (input.compacted ? 'post-compaction-estimate' : 'estimate') : 'provider',
  };
}

export function newerContextMeasurement(previous: ContextMeasurement | undefined, next: ContextMeasurement | undefined) {
  if (!next) return previous;
  if (!previous) return next;
  if (next.measuredAt < previous.measuredAt) return previous;
  if (next.source === 'estimate' && previous.source === 'provider') return previous;
  return next;
}
