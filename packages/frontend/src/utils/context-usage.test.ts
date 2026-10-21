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
  it('restores valid provider context after zero-usage error and duplicate compaction callback', () => {
    // Persisted metrics model the backend run-context output; frontend tests do not import backend code.
    let contextInput = 125000;
    let awaitingPostCompactionMeasurement = false;
    const restore = () => computeContextUsageStat({ cost: emptyCost, messages: [msg({
      id: 'saved', timestamp: 1000, metadata: { usage: JSON.parse(JSON.stringify({
        context_input_tokens: contextInput,
        context_estimated_tokens: 317605, context_window_size: 353400,
        context_compacted: awaitingPostCompactionMeasurement,
      })) },
    })] });
    expect(Math.round(restore().contextPct)).toBe(35);
    expect(restore().isEstimated).toBe(false);
    contextInput = 30000;
    awaitingPostCompactionMeasurement = false;
    expect(restore().contextInput).toBe(30000);
    expect(restore().isEstimated).toBe(false);
  });

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
      cost: { ...emptyCost, contextInputTokens: 260_134, contextEstimatedTokens: 85_505, contextCompacted: true, contextWindowSize: 258_400 },
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
          metadata: { usage: { context_input_tokens: 260_134, context_estimated_tokens: 85_505, context_compacted: true, context_window_size: 258_400 } },
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


it('prefers measured input over a smaller unconfirmed estimate', () => {
  const stat = computeContextUsageStat({ cost: { ...emptyCost, contextInputTokens: 83791, contextEstimatedTokens: 20000, contextWindowSize: 922000 }, messages: [] });
  expect(stat.contextInput).toBe(83791);
  expect(stat.isEstimated).toBe(false);
  expect(stat.contextPct).toBeCloseTo(9.088);
});

it('prefers persisted measured input without a confirmed compaction', () => {
  const stat = computeContextUsageStat({ cost: emptyCost, messages: [msg({ role: 'assistant', metadata: { usage: { context_input_tokens: 83791, context_estimated_tokens: 20000, context_window_size: 922000 } } })] });
  expect(stat.contextInput).toBe(83791);
  expect(stat.isEstimated).toBe(false);
});

it('shows 100 percent at the reported compaction budget without changing the model window', () => {
  const stat = computeContextUsageStat({ cost: { ...emptyCost, contextInputTokens: 144_000,
    contextWindowSize: 200_000, compactThresholdTokens: 144_000, contextSnapshot: { windowTokens: 200_000, pressure: { tokens: 144_000, thresholdTokens: 144_000, policy: 'tower-pre-prompt', source: 'projection', observedAt: 1 } } }, messages: [] });
  expect(stat.contextPct).toBe(72);
  expect(stat.pressurePct).toBe(100);
  expect(stat.usesCompactionBudget).toBe(true);
  expect(stat.measurement?.windowTokens).toBe(200_000);
});

it('restores the operational budget from persisted usage', () => {
  const stat = computeContextUsageStat({ cost: emptyCost, messages: [{ id: 'budget', role: 'assistant',
    content: 'ok', timestamp: 1, metadata: { usage: { context_input_tokens: 72_000,
      context_window_size: 200_000, compact_threshold_tokens: 144_000, context_snapshot: { capturedAt: '2026-01-01T00:00:00.000Z', windowTokens: 200_000, pressure: { tokens: 72_000, thresholdTokens: 144_000, policy: 'tower-pre-prompt', source: 'projection', observedAt: 1 } } } } } as any] });
  expect(stat.contextPct).toBe(36);
  expect(stat.pressurePct).toBe(50);
  expect(stat.usesCompactionBudget).toBe(true);
});

it('preserves model remaining while displaying a different pressure numerator', () => {
  const stat = computeContextUsageStat({ cost: { ...emptyCost, contextInputTokens: 100_000, contextWindowSize: 200_000,
    contextSnapshot: { windowTokens: 200_000, pressure: { tokens: 144_000, thresholdTokens: 144_000,
      policy: 'tower-pre-prompt', source: 'projection', observedAt: 1 } } }, messages: [] });
  expect(stat.contextInput).toBe(100_000);
  expect(stat.maxTokens).toBe(200_000);
  expect(stat.contextRemaining).toBe(100_000);
  expect(stat.pressurePct).toBe(100);
});

it('does not resurrect old pressure when a newer snapshot invalidates it', () => {
  const stat = computeContextUsageStat({ cost: { ...emptyCost, contextSnapshot: { capturedAt: '2026-01-02T00:00:00Z', windowTokens: 200_000 } },
    messages: [msg({ metadata: { usage: { context_snapshot: { capturedAt: '2026-01-01T00:00:00Z', windowTokens: 200_000,
      pressure: { tokens: 144_000, thresholdTokens: 144_000, policy: 'tower-pre-prompt', source: 'projection', observedAt: 1 } } } } })] });
  expect(stat.pressure).toBeUndefined();
});
