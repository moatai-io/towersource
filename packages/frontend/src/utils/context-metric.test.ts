import { describe, it, expect } from 'vitest';
import { resolveContextMetric, preserveMeasuredContext } from './context-metric';
describe('display context contract', () => {
  it('never substitutes risk estimates for measured input', () => {
    expect(resolveContextMetric({ actual: 262655, estimated: 989949 })).toEqual({ tokens: 262655, isEstimated: false });
  });
  it('only uses estimates without measurement or after confirmed compaction', () => {
    expect(resolveContextMetric({ estimated: 20000 }).isEstimated).toBe(true);
    expect(resolveContextMetric({ actual: 262655, estimated: 20000, compacted: true }).tokens).toBe(20000);
  });
  it('ignores invalid measurements', () => {
    expect(resolveContextMetric({ actual: NaN, estimated: Infinity }).tokens).toBe(0);
  });
  it('preserves last measured context during incomplete live updates', () => {
    const result = preserveMeasuredContext({ contextInputTokens: 262655, contextWindowSize: 922000 }, { contextInputTokens: 0, contextEstimatedTokens: 989949, contextWindowSize: 0 });
    expect(result.contextInputTokens).toBe(262655);
    expect(result.contextWindowSize).toBe(922000);
    expect(resolveContextMetric({ actual: result.contextInputTokens, estimated: result.contextEstimatedTokens }).isEstimated).toBe(false);
  });
  it('accepts new measurement and confirmed compaction instead of retaining stale input', () => {
    expect(preserveMeasuredContext({ contextInputTokens: 260000 }, { contextInputTokens: 270000 }).contextInputTokens).toBe(270000);
    expect(preserveMeasuredContext({ contextInputTokens: 260000 }, { contextInputTokens: 0, contextEstimatedTokens: 20000, contextCompacted: true }).contextInputTokens).toBe(0);
  });
});
