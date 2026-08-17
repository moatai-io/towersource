import { describe, expect, it } from 'vitest';
import { chooseAssistantContentToSave, extractPiUsageDelta, shouldApplyMessageStopReason } from '../pi/message-end-policy.js';

describe('Pi message_end policy helpers', () => {
  it('preserves previous stop reason when a trailing empty error message arrives', () => {
    expect(shouldApplyMessageStopReason({
      msgStopReason: 'error',
      msgContentLen: 0,
      previousStopReason: 'toolUse',
    })).toBe(false);
  });

  it('applies stop reason when content is non-empty or no previous reason exists', () => {
    expect(shouldApplyMessageStopReason({
      msgStopReason: 'error',
      msgContentLen: 1,
      previousStopReason: 'toolUse',
    })).toBe(true);
    expect(shouldApplyMessageStopReason({
      msgStopReason: 'error',
      msgContentLen: 0,
      previousStopReason: undefined,
    })).toBe(true);
  });

  it('normalizes Pi usage with cache and cost fields', () => {
    expect(extractPiUsageDelta({
      input: 100,
      output: 20,
      cacheRead: 7,
      cacheWrite: 3,
      cost: { total: 0.12 },
    })).toEqual({ input: 100, output: 20, cacheRead: 7, cacheWrite: 3, reasoning: 0, costUsd: 0.12 });
  });

  it('defaults missing usage numbers to zero', () => {
    expect(extractPiUsageDelta({})).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: undefined });
  });

  it('uses non-empty final content, otherwise falls back to accumulator content', () => {
    const finalContent = [{ type: 'text' as const, text: 'final' }];
    const accumulatorContent = [{ type: 'text' as const, text: 'acc' }];

    expect(chooseAssistantContentToSave({ finalContent, accumulatorContent })).toBe(finalContent);
    expect(chooseAssistantContentToSave({ finalContent: [], accumulatorContent })).toBe(accumulatorContent);
  });
});
