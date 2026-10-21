import { describe, expect, it } from 'vitest';
import { contextInputFromUsageOrRow } from './message-metrics';

describe('contextInputFromUsageOrRow', () => {
  it('uses the authoritative context snapshot when the terminal message persisted one', () => {
    expect(contextInputFromUsageOrRow({
      input_tokens: 1_647,
      metadata: { usage: { context_input_tokens: 73_839, cache_read_tokens: 72_192 } },
    })).toBe(73_839);
  });

  it('reconstructs Responses context from uncached input plus cache reads', () => {
    expect(contextInputFromUsageOrRow({
      input_tokens: 2_651,
      metadata: { usage: { cache_read_tokens: 74_240 } },
    })).toBe(76_891);
  });

  it('does not present a legacy input-only turn count as full context usage', () => {
    expect(contextInputFromUsageOrRow({
      input_tokens: 432,
      metadata: { usage: { cache_read_tokens: 0 } },
    })).toBe(0);
  });
});


it('requires confirmed compaction before replacing measured persisted input', () => {
  const usage = { context_input_tokens: 83791, context_estimated_tokens: 20000 };
  expect(contextInputFromUsageOrRow({ metadata: { usage } })).toBe(83791);
  expect(contextInputFromUsageOrRow({ metadata: { usage: { ...usage, context_compacted: true } } })).toBe(20000);
});
