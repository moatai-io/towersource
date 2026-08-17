import { describe, expect, it, vi } from 'vitest';
import { PiRunContext, buildPiContextSnapshot } from '../pi/run-context.js';

describe('PiRunContext', () => {
  it('tracks assistant message identity and rotates per iteration', () => {
    const ids = ['msg-1', 'msg-2'];
    const ctx = new PiRunContext({ modelContextWindow: 200_000, makeId: () => ids.shift()! });

    expect(ctx.msgId).toBe('msg-1');
    expect(ctx.chooseMetricsMsgId()).toBe('msg-1');

    ctx.markAssistantSaved();
    expect(ctx.assistantSaved).toBe(true);
    expect(ctx.lastSavedAssistantMsgId).toBe('msg-1');
    expect(ctx.assistantMsgIdsThisTurn).toEqual(['msg-1']);
    expect(ctx.chooseMetricsMsgId()).toBe('msg-1');

    ctx.rotateAssistantIteration();
    expect(ctx.msgId).toBe('msg-2');
    expect(ctx.assistantSaved).toBe(false);
    expect(ctx.chooseMetricsMsgId()).toBe('msg-1');
  });

  it('deduplicates saved assistant ids', () => {
    const ctx = new PiRunContext({ modelContextWindow: 100, makeId: () => 'same' });

    ctx.markAssistantSaved('same');
    ctx.markAssistantSaved('same');

    expect(ctx.assistantMsgIdsThisTurn).toEqual(['same']);
  });

  it('records cumulative and last-iteration usage deltas', () => {
    const ctx = new PiRunContext({ modelContextWindow: 128_000, makeId: () => 'm' });

    ctx.recordUsage({ input: 10, output: 2, cacheRead: 3, cacheWrite: 4, reasoningTokens: 6, cost: { total: 0.1 } });
    ctx.recordUsage({ input: 20, output: 5, cacheRead: 7, cacheWrite: 8, output_tokens_details: { reasoning_tokens: 9 }, cost: { total: 0.2 } });

    expect(ctx.iterationCount).toBe(2);
    expect(ctx.cumulativeInput).toBe(30);
    expect(ctx.cumulativeOutput).toBe(7);
    expect(ctx.cumulativeCacheRead).toBe(10);
    expect(ctx.cumulativeCacheWrite).toBe(12);
    expect(ctx.cumulativeReasoning).toBe(15);
    expect(ctx.cumulativeCostUsd).toBeCloseTo(0.3);
    expect(ctx.lastIterationInput).toBe(20);
    expect(ctx.lastIterationOutput).toBe(5);
    expect(ctx.lastIterationReasoning).toBe(9);
    expect(ctx.lastCostUsd).toBe(0.2);
  });

  it('builds turn usage summary with normalized iteration count and separated actual/risk context', () => {
    const ctx = new PiRunContext({ modelContextWindow: 400, makeId: () => 'm' });

    expect(ctx.actualContextInputTokens()).toBe(0);
    expect(ctx.riskContextEstimateTokens(123)).toBe(123);
    expect(ctx.usageSummary({ durationMs: 50, stopReason: 'stop', contextInputTokens: 0 }).numIterations).toBe(1);

    ctx.recordUsage({ input: 300, output: 10, cacheRead: 20, cacheWrite: 5 });
    expect(ctx.actualContextInputTokens()).toBe(325);
    expect(ctx.riskContextEstimateTokens(123)).toBe(325);

    ctx.compactionSucceededThisTurn = true;
    expect(ctx.riskContextEstimateTokens(123)).toBe(123);

    expect(ctx.usageSummary({
      durationMs: 50,
      stopReason: 'stop',
      contextInputTokens: 325,
    })).toMatchObject({
      inputTokens: 300,
      outputTokens: 10,
      durationMs: 50,
      stopReason: 'stop',
      contextInputTokens: 325,
      contextOutputTokens: 10,
      contextWindowSize: 400,
      numIterations: 1,
      cacheReadTokens: 20,
      cacheCreationTokens: 5,
      reasoningTokens: 0,
    });
  });

  it('builds a source-labeled terminal context snapshot without changing legacy metrics', () => {
    expect(buildPiContextSnapshot({
      actualTokens: 107,
      requestTokens: 150,
      estimatedTokens: 160,
      windowTokens: 1000,
      capturedAt: '2026-07-31T00:00:00.000Z',
    })).toEqual({
      actualTokens: 107,
      requestTokens: 150,
      estimatedTokens: 160,
      windowTokens: 1000,
      actualSource: 'provider',
      requestSource: 'sanitized-request',
      capturedAt: '2026-07-31T00:00:00.000Z',
      terminal: true,
    });

    expect(buildPiContextSnapshot({
      actualTokens: 0,
      requestTokens: undefined,
      estimatedTokens: 80,
      windowTokens: 1000,
      capturedAt: '2026-07-31T00:00:00.000Z',
    })).toEqual({
      estimatedTokens: 80,
      windowTokens: 1000,
      actualSource: 'none',
      requestSource: 'none',
      capturedAt: '2026-07-31T00:00:00.000Z',
      terminal: true,
    });
  });

  it('reports duration from injected turn start time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const ctx = new PiRunContext({ modelContextWindow: 100, turnStartTime: Date.now(), makeId: () => 'm' });

    vi.setSystemTime(1_250);
    expect(ctx.durationMs).toBe(250);
    vi.useRealTimers();
  });
});
