import { it, expect } from 'vitest';
import { useChatStore } from './chat-store';
import { computeContextUsageStat } from '../utils/context-usage';
it('request context updates refresh the status without accumulating cost or turns', () => {
  useChatStore.getState().clearMessages();
  useChatStore.getState().setCost({ inputTokens: 100, outputTokens: 10, totalCost: 0.1 });
  const before = useChatStore.getState().cost;
  for (const tokens of [262655, 400000, 650000]) {
    useChatStore.getState().setCost({ contextInputTokens: tokens, contextWindowSize: 922000, contextEstimatedTokens: 0, contextCompacted: false });
  }
  const after = useChatStore.getState().cost;
  expect(after.cumulativeInputTokens).toBe(before.cumulativeInputTokens);
  expect(after.cumulativeOutputTokens).toBe(before.cumulativeOutputTokens);
  expect(after.turnCount).toBe(before.turnCount);
  expect(after.totalCost).toBe(before.totalCost);
  const stat = computeContextUsageStat({ cost: after, messages: [] });
  expect(stat.contextInput).toBe(650000);
  expect(stat.contextPct).toBeCloseTo(70.5, 1);
  expect(stat.isEstimated).toBe(false);
  useChatStore.getState().clearMessages();
});
