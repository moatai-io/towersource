import { describe, expect, it } from 'vitest';
import { computeContextUsageStat, fmtTokensShort } from './context-usage';
import type { ChatMessage, CostInfo } from '../stores/chat-store';

const emptyCost: CostInfo = {
  totalCost: 0,
  inputTokens: 0,
  outputTokens: 0,
  cumulativeInputTokens: 0,
  cumulativeOutputTokens: 0,
  turnCount: 0,
  contextInputTokens: 0,
  contextOutputTokens: 0,
  contextWindowSize: 0,
  contextEstimatedTokens: 0,
};

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: partial.id || Math.random().toString(36),
    role: partial.role || 'assistant',
    content: [],
    timestamp: 0,
    ...partial,
  };
}

describe('context usage stat line', () => {
  it('uses live engine context metrics first', () => {
    const stat = computeContextUsageStat({
      cost: { ...emptyCost, contextInputTokens: 80_000, contextOutputTokens: 5_000, contextWindowSize: 200_000 },
      messages: [msg({ role: 'assistant', inputTokens: 10_000, contextWindowSize: 100_000 })],
    });

    expect(stat.contextUsed).toBe(80_000);
    expect(stat.maxTokens).toBe(200_000);
    expect(stat.contextPct).toBeCloseTo(40);
  });

  it('uses post-compaction estimated context over stale raw provider input', () => {
    const stat = computeContextUsageStat({
      cost: { ...emptyCost, contextInputTokens: 260_134, contextEstimatedTokens: 85_505, contextWindowSize: 258_400 },
      messages: [],
    });

    expect(stat.contextInput).toBe(85_505);
    expect(stat.contextPct).toBeCloseTo(33.09, 1);
  });

  it('falls back to persisted assistant context metrics after reload', () => {
    const stat = computeContextUsageStat({
      cost: emptyCost,
      messages: [
        msg({ role: 'assistant', inputTokens: 10_000, outputTokens: 100, contextWindowSize: 100_000 }),
        msg({ role: 'assistant', inputTokens: 50_000, outputTokens: 1_000, contextWindowSize: 272_000 }),
      ],
    });

    expect(stat.contextInput).toBe(50_000);
    expect(stat.contextOutput).toBe(1_000);
    expect(stat.maxTokens).toBe(272_000);
    expect(stat.contextRemaining).toBe(222_000);
  });

  it('falls back to persisted estimated context metrics after reload', () => {
    const stat = computeContextUsageStat({
      cost: emptyCost,
      messages: [
        msg({
          role: 'assistant',
          inputTokens: 260_134,
          contextEstimatedTokens: 85_505,
          contextWindowSize: 258_400,
          metadata: { usage: { context_input_tokens: 260_134, context_estimated_tokens: 85_505, context_window_size: 258_400 } },
        }),
      ],
    });

    expect(stat.contextInput).toBe(85_505);
    expect(stat.maxTokens).toBe(258_400);
  });

  it('counts rendered user messages, excluding hidden/system-like rows', () => {
    const stat = computeContextUsageStat({
      cost: emptyCost,
      modelContextWindow: 200_000,
      messages: [
        msg({ role: 'user' }),
        msg({ role: 'user', metadata: { hidden: 'server-resume' } }),
        msg({ role: 'user', parentToolUseId: 'tool-1' }),
        msg({ role: 'assistant', inputTokens: 1_000 }),
      ],
    });

    expect(stat.userMsgCount).toBe(1);
  });

  it('formats compact token labels', () => {
    expect(fmtTokensShort(999)).toBe('999');
    expect(fmtTokensShort(12_300)).toBe('12.3k');
    expect(fmtTokensShort(1_250_000)).toBe('1.3M');
  });
});
