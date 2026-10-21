import { it, expect } from 'vitest';
import { normalizeContextMeasurement as normalize, newerContextMeasurement as newer } from './context-measurement';
it('normalizes cache-inclusive input without double counting explicit input', () => {
  expect(normalize({ requestId: 'a', measuredAt: 1, uncached: 54814, cacheRead: 43264 })?.inputTokens).toBe(98078);
  expect(normalize({ requestId: 'a', measuredAt: 1, actual: 98078, cacheRead: 43264 })?.inputTokens).toBe(98078);
});
it('rejects older events and risk estimates replacing actual input', () => {
  const actual = normalize({ requestId: 'b', measuredAt: 2, actual: 260000 });
  expect(newer(actual, normalize({ requestId: 'a', measuredAt: 1, actual: 10000 }))).toBe(actual);
  expect(newer(actual, normalize({ requestId: 'c', measuredAt: 3, estimated: 990000 }))).toBe(actual);
});
it('allows post-compaction estimate then restores provider measurement', () => {
  const estimate = normalize({ requestId: 'a', measuredAt: 2, actual: 260000, estimated: 20000, compacted: true });
  expect(estimate?.source).toBe('post-compaction-estimate');
  expect(newer(estimate, normalize({ requestId: 'b', measuredAt: 3, actual: 25000 }))?.source).toBe('provider');
});
it('does not invent a window', () => {
  expect(normalize({ requestId: 'a', measuredAt: 1, actual: 100 })?.windowTokens).toBeUndefined();
});

it('rejects invalid pressure and keeps an invalidation newer than delayed telemetry', async () => {
  const { normalizeContextPressure, newerContextSnapshot } = await import('./context-measurement');
  expect(normalizeContextPressure({ windowTokens: 200_000, pressure: { tokens: 1, thresholdTokens: Infinity,
    policy: 'tower-pre-prompt', source: 'projection', observedAt: 1 } })).toBeUndefined();
  const reset = { capturedAt: '2026-01-02T00:00:00Z', windowTokens: 200_000 };
  expect(newerContextSnapshot(reset, { capturedAt: '2026-01-01T00:00:00Z' })).toBe(reset);
});
