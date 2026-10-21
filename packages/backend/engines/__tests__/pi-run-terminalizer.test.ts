import { describe, expect, it, vi } from 'vitest';
import { PiRunContext } from '../pi/run-context.js';
import { PiRunTerminalizer, resolvePiTurnDurationMs, type PiRunTerminalizerState } from '../pi/run-terminalizer.js';
import type { TowerMessage } from '../types.js';

function makeTerminalizer(overrides: Partial<{
  state: Partial<PiRunTerminalizerState>;
  estimateLiveContextTokens: () => number;
  acceptedAt: string;
  workLedgerTurnStartedAt: string;
  finalizeWorkLedger: ReturnType<typeof vi.fn>;
  persistTerminalErrorNotice: ReturnType<typeof vi.fn>;
}> = {}) {
  const runCtx = new PiRunContext({
    modelContextWindow: 1000,
    turnStartTime: Date.now(),
    initialMsgId: 'msg-1',
    makeId: () => 'msg-next',
  });
  runCtx.markAssistantSaved('msg-1');
  runCtx.recordUsage({ input: 100, output: 20, cacheRead: 3, cacheWrite: 4, cost: { total: 0.05 } });

  const eventQueue: TowerMessage[] = [];
  const calls: string[] = [];
  const updateMessageMetrics = vi.fn(async () => { calls.push('updateMetrics'); });
  const flushAssistantEvent = vi.fn(() => { calls.push('flushAssistantEvent'); });
  const flushAssistantDbUpdate = vi.fn(() => { calls.push('flushAssistantDbUpdate'); });
  const flushDbWrites = vi.fn(async () => { calls.push('flushDbWrites'); });
  const trackDbWrite = vi.fn((op: void | Promise<void>) => {
    calls.push('trackDbWrite');
    return Promise.resolve(op).then(() => undefined);
  });
  const finalizeWorkLedger = overrides.finalizeWorkLedger ?? vi.fn(async () => 0);
  const state: PiRunTerminalizerState = {
    stopReason: 'stop',
    assistantSaved: true,
    currentMsgId: 'msg-1',
    lastSavedAssistantMsgId: 'msg-1',
    iterationCount: 1,
    lastIterationInput: 100,
    lastIterationOutput: 20,
    lastIterationCacheRead: 3,
    lastIterationCacheWrite: 4,
    lastCostUsd: 0.05,
    watchdogAborted: null,
    transientAbortVisibleSuppressed: false,
    toolCallsForTelemetry: 2,
    autoResume: false,
    queueLenBeforeDone: 0,
    oversizedPreflightRecoveryRequested: false,
    compactionSucceededThisTurn: false,
    ...overrides.state,
  };

  const terminalizer = new PiRunTerminalizer({
    sessionId: 'session-12345678',
    runCtx,
    acceptedAt: overrides.acceptedAt,
    workLedgerTurnStartedAt: overrides.workLedgerTurnStartedAt,
    finalizeWorkLedger,
    persistTerminalErrorNotice: overrides.persistTerminalErrorNotice,
    callbacks: { updateMessageMetrics },
    eventQueue,
    modelLabel: () => 'litellm/smart',
    getState: () => state,
    estimateLiveContextTokens: overrides.estimateLiveContextTokens ?? (() => 80),
    flushAssistantEvent,
    flushAssistantDbUpdate,
    flushDbWrites,
    trackDbWrite,
  });

  return {
    terminalizer,
    runCtx,
    eventQueue,
    calls,
    updateMessageMetrics,
    flushAssistantEvent,
    flushAssistantDbUpdate,
    flushDbWrites,
    trackDbWrite,
    finalizeWorkLedger,
  };
}

describe('PiRunTerminalizer', () => {
  it('persists and emits the last valid measurement after a zero-usage failure', async () => {
    const t = makeTerminalizer({ estimateLiveContextTokens: () => 900 });
    t.runCtx.recordUsage({ input: 0, output: 0 });
    await t.terminalizer.emitTurnDone('error');
    expect(t.updateMessageMetrics).toHaveBeenCalledWith('msg-1', expect.objectContaining({
      contextInputTokens: 107, contextEstimatedTokens: 900, contextCompacted: false,
    }));
    expect(t.eventQueue.find(m => m.type === 'turn_done')).toMatchObject({ usage: {
      contextInputTokens: 107, contextEstimatedTokens: 900, contextCompacted: false,
    } });
  });

  it('clears the estimate-precedence flag once post-compaction usage arrives', async () => {
    const t = makeTerminalizer({ estimateLiveContextTokens: () => 900 });
    t.runCtx.recordCompactionSuccess(1);
    t.runCtx.recordUsage({ input: 30 });
    t.runCtx.recordUsage({ input: 0 });
    await t.terminalizer.emitTurnDone();
    expect(t.updateMessageMetrics).toHaveBeenCalledWith('msg-1', expect.objectContaining({
      contextInputTokens: 30, contextCompacted: false,
    }));
    expect(t.eventQueue.find(m => m.type === 'turn_done')).toMatchObject({ usage: {
      contextInputTokens: 30, contextCompacted: false,
    } });
  });
  it('uses acceptedAt as the total wall-clock duration boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T12:00:10.000Z'));
    const t = makeTerminalizer({ acceptedAt: '2026-07-20T12:00:00.000Z' });

    await t.terminalizer.emitTurnDone();

    expect(t.updateMessageMetrics).toHaveBeenCalledWith('msg-1', expect.objectContaining({ durationMs: 10_000 }));
    expect(t.eventQueue.find((m) => m.type === 'turn_done')).toMatchObject({ usage: { durationMs: 10_000 } });
    vi.useRealTimers();
  });

  it('falls back to the current run duration when acceptedAt is stale', () => {
    const nowMs = Date.parse('2026-07-27T12:00:00.000Z');

    expect(resolvePiTurnDurationMs({
      acceptedAt: '2026-07-20T12:00:00.000Z',
      nowMs,
      runDurationMs: 48_000,
    })).toBe(48_000);
  });

  it('falls back to the current run duration when acceptedAt is in the future', () => {
    const nowMs = Date.parse('2026-07-27T12:00:00.000Z');

    expect(resolvePiTurnDurationMs({
      acceptedAt: '2026-07-27T12:00:05.000Z',
      nowMs,
      runDurationMs: 2_500,
    })).toBe(2_500);
  });

  it('finalizes current-turn Work Ledger rows as completed on a successful terminal turn', async () => {
    const finalizeWorkLedger = vi.fn(async () => 1);
    const t = makeTerminalizer({
      workLedgerTurnStartedAt: '2026-07-31T09:00:00.000Z',
      finalizeWorkLedger,
    });

    await t.terminalizer.emitTurnDone();

    expect(finalizeWorkLedger).toHaveBeenCalledWith({
      sessionId: 'session-12345678',
      turnStartedAt: '2026-07-31T09:00:00.000Z',
      outcome: 'completed',
    });
  });

  it.each(['error', 'aborted'] as const)('finalizes current-turn Work Ledger rows as failed on %s', async (stop) => {
    const finalizeWorkLedger = vi.fn(async () => 1);
    const t = makeTerminalizer({
      workLedgerTurnStartedAt: '2026-07-31T09:00:00.000Z',
      finalizeWorkLedger,
    });

    await t.terminalizer.emitTurnDone(stop);

    expect(finalizeWorkLedger).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
  });

  it('does not prevent turn_done when Work Ledger finalization fails', async () => {
    const t = makeTerminalizer({
      workLedgerTurnStartedAt: '2026-07-31T09:00:00.000Z',
      finalizeWorkLedger: vi.fn(async () => { throw new Error('database unavailable'); }),
    });

    await t.terminalizer.emitTurnDone();

    expect(t.eventQueue.at(-1)).toMatchObject({ type: 'turn_done' });
  });

  it('emits turn_done exactly once even if called twice', async () => {
    const t = makeTerminalizer();

    await t.terminalizer.emitTurnDone();
    await t.terminalizer.emitTurnDone('error');

    expect(t.eventQueue.filter((m) => m.type === 'turn_done')).toHaveLength(1);
    expect(t.updateMessageMetrics).toHaveBeenCalledTimes(1);
    expect(t.terminalizer.hasTurnDoneFired).toBe(true);
  });

  it('flushes assistant stream and DB before metrics, then flushes metrics before enqueueing turn_done', async () => {
    const t = makeTerminalizer();

    await t.terminalizer.emitTurnDone();

    expect(t.calls).toEqual([
      'flushAssistantEvent',
      'flushAssistantDbUpdate',
      'flushDbWrites',
      'updateMetrics',
      'trackDbWrite',
      'flushDbWrites',
    ]);
    expect(t.eventQueue[0]?.type).toBe('turn_done');
  });

  it('builds usage summary from PiRunContext and per-iteration metrics from state', async () => {
    const t = makeTerminalizer({ estimateLiveContextTokens: () => 150 });

    await t.terminalizer.emitTurnDone('aborted');

    expect(t.updateMessageMetrics).toHaveBeenCalledWith('msg-1', expect.objectContaining({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
      costUsd: 0.05,
      contextInputTokens: 107,
      contextWindowSize: 1000,
      contextEstimatedTokens: 150,
      compactThresholdTokens: 0,
      contextSnapshot: expect.objectContaining({
        actualTokens: 107,
        estimatedTokens: 150,
        windowTokens: 1000,
        actualSource: 'provider',
        requestSource: 'none',
        terminal: true,
      }),
    }));
    expect(t.eventQueue[0]).toMatchObject({
      type: 'turn_done',
      sessionId: 'session-12345678',
      msgId: 'msg-1',
      assistantMsgIds: ['msg-1'],
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.05,
        stopReason: 'aborted',
        contextInputTokens: 107,
        contextOutputTokens: 20,
        contextWindowSize: 1000,
        contextEstimatedTokens: 150,
        compactThresholdTokens: 0,
        numIterations: 1,
        cacheReadTokens: 3,
        cacheCreationTokens: 4,
      },
    });
  });

  it('normalizes final toolUse iteration boundary to user-facing stop', async () => {
    const t = makeTerminalizer({ state: { stopReason: 'toolUse' } });

    await t.terminalizer.emitTurnDone();

    expect(t.eventQueue[0]).toMatchObject({ type: 'turn_done', usage: { stopReason: 'stop' } });
  });

  it('surfaces a retryable error when a run completes after tool use without final text', async () => {
    const t = makeTerminalizer({
      state: {
        stopReason: 'stop',
        lastAssistant: {
          stopReason: 'toolUse',
          blockTypes: ['tool_use'],
          hasToolCall: true,
          textTail: '',
          textAfterLastToolCall: '',
          continuationIntent: false,
        },
      },
    });

    await t.terminalizer.emitTurnDone();

    expect(t.eventQueue[0]).toMatchObject({
      type: 'engine_error',
      sessionId: 'session-12345678',
      recoverable: true,
      retryable: true,
    });
    expect(t.eventQueue[1]).toMatchObject({ type: 'turn_done', usage: { stopReason: 'stop' } });
  });

  it('converts empty queued completion into an error instead of a silent success', async () => {
    const t = makeTerminalizer({
      state: {
        stopReason: undefined,
        assistantSaved: false,
        lastSavedAssistantMsgId: null,
        iterationCount: 0,
        lastIterationInput: 0,
        lastIterationOutput: 0,
        lastIterationCacheRead: 0,
        lastIterationCacheWrite: 0,
        lastCostUsd: undefined,
        toolCallsForTelemetry: 0,
        queueLenBeforeDone: 1,
        lastAssistant: undefined,
      },
    });

    await t.terminalizer.emitTurnDone();

    expect(t.updateMessageMetrics).not.toHaveBeenCalled();
    expect(t.eventQueue[0]).toMatchObject({
      type: 'engine_error',
      sessionId: 'session-12345678',
      recoverable: true,
      retryable: true,
    });
    expect(t.eventQueue[1]).toMatchObject({ type: 'turn_done', usage: { stopReason: 'error' } });
  });

  it('surfaces context overflow when compaction recovery still ends with no assistant text', async () => {
    const t = makeTerminalizer({
      state: {
        stopReason: 'error',
        assistantSaved: false,
        lastSavedAssistantMsgId: null,
        iterationCount: 2,
        lastIterationInput: 0,
        lastIterationOutput: 0,
        toolCallsForTelemetry: 0,
        oversizedPreflightRecoveryRequested: true,
        compactionSucceededThisTurn: true,
        lastAssistant: undefined,
      },
    });

    await t.terminalizer.emitTurnDone();

    expect(t.eventQueue[0]).toMatchObject({
      type: 'engine_error',
      sessionId: 'session-12345678',
      recoverable: true,
      retryable: false,
    });
    expect(t.eventQueue[0]).toMatchObject({
      message: expect.stringContaining('컨텍스트'),
    });
    expect(t.eventQueue[1]).toMatchObject({ type: 'turn_done', usage: { stopReason: 'error' } });
  });

  it('keeps Tower preflight internal after Pi overflow recovery succeeds', async () => {
    const persistTerminalErrorNotice = vi.fn();
    const t = makeTerminalizer({
      persistTerminalErrorNotice,
      state: {
        stopReason: 'stop', compactionSucceededThisTurn: true, oversizedPreflightRecoveryRequested: false,
        providerErrorMessage: '',
        lastAssistant: { stopReason: 'stop', blockTypes: ['text'], hasToolCall: false,
          textTail: 'Recovered answer', textAfterLastToolCall: 'Recovered answer', continuationIntent: false },
      },
    });
    await t.terminalizer.emitTurnDone();
    expect(persistTerminalErrorNotice).not.toHaveBeenCalled();
    expect(t.eventQueue.find((m) => m.type === 'engine_error')).toBeUndefined();
    expect(t.eventQueue.find((m) => m.type === 'turn_done')).toMatchObject({ usage: { stopReason: 'stop' } });
  });

  it('surfaces a concise notice only if Tower preflight recovery ultimately fails', async () => {
    const persistTerminalErrorNotice = vi.fn();
    const t = makeTerminalizer({
      persistTerminalErrorNotice,
      state: {
        stopReason: 'error', oversizedPreflightRecoveryRequested: true,
        providerErrorMessage: 'litellm-responses API error (400): context_length_exceeded: Pi Responses preflight rejected near-context request before upstream send (bodyEstimatedPromptTokens=363505 >= preflightFloor=360000)',
      },
    });
    await t.terminalizer.emitTurnDone('error');
    expect(t.eventQueue.find((m) => m.type === 'engine_error')).toMatchObject({
      message: expect.stringContaining('추정치'), retryable: false,
    });
    expect(persistTerminalErrorNotice).toHaveBeenCalledWith(expect.stringContaining('추정치'));
    expect(JSON.stringify(t.eventQueue)).not.toContain('363505');
  });

  it('does not attribute a later unrelated provider failure to a historical compaction', async () => {
    const t = makeTerminalizer({ state: {
      stopReason: 'error', compactionSucceededThisTurn: true,
      oversizedPreflightRecoveryRequested: false, providerErrorMessage: 'Service temporarily unavailable',
      lastAssistant: undefined,
    } });
    await t.terminalizer.emitTurnDone('error');
    const notice = t.eventQueue.find((m) => m.type === 'engine_error');
    expect(notice).toMatchObject({ message: expect.stringContaining('AI 제공자 오류'), retryable: true });
    expect(JSON.stringify(notice)).not.toContain('컨텍스트');
  });

  it('distinguishes interrupted tool boundaries from request-size failures', async () => {
    const persistTerminalErrorNotice = vi.fn();
    const t = makeTerminalizer({ persistTerminalErrorNotice, state: {
      stopReason: 'error',
      lastAssistant: { stopReason: 'toolUse', blockTypes: ['tool_use'], textTail: 'Checking state', hasToolCall: true, textAfterLastToolCall: '', continuationIntent: false },
    } });
    await t.terminalizer.emitTurnDone('error');
    expect(t.eventQueue.find((m) => m.type === 'engine_error')).toMatchObject({
      message: expect.stringContaining('저장된 작업 상태'), retryable: true,
    });
    expect(JSON.stringify(t.eventQueue)).not.toContain('요청 크기 또는 제공자 오류');
    expect(persistTerminalErrorNotice).toHaveBeenCalled();
  });

  it('persists a safe 413 notice when a provider error follows tool-use commentary', async () => {
    const persistTerminalErrorNotice = vi.fn();
    const t = makeTerminalizer({
      persistTerminalErrorNotice,
      state: {
        stopReason: 'error', providerErrorMessage: 'API error (413): 413 Request Entity Too Large',
        lastAssistant: {
          stopReason: 'toolUse', blockTypes: ['text', 'tool_use'], hasToolCall: true,
          textTail: 'I will check the files', textAfterLastToolCall: '', continuationIntent: false,
        },
      },
    });
    await t.terminalizer.emitTurnDone();
    expect(persistTerminalErrorNotice).toHaveBeenCalledWith(expect.stringContaining('요청 본문'));
    expect(t.eventQueue.find((m) => m.type === 'engine_error')).toMatchObject({ message: expect.stringContaining('요청 본문') });
    expect(t.eventQueue.find((m) => m.type === 'turn_done')).toMatchObject({ usage: { stopReason: 'error' } });
  });

  it('forceTerminalizeRun marks forced state, aborts, emits aborted turn_done, and wakes the loop', async () => {
    const runCtx = new PiRunContext({ modelContextWindow: 100, initialMsgId: 'm' });
    const eventQueue: TowerMessage[] = [];
    const markClosing = vi.fn();
    const abortSession = vi.fn();
    const setDone = vi.fn();
    const wakeYieldLoop = vi.fn();
    const terminalizer = new PiRunTerminalizer({
      sessionId: 'session-force',
      runCtx,
      callbacks: { updateMessageMetrics: vi.fn(async () => {}) },
      eventQueue,
      modelLabel: () => 'p/m',
      getState: () => ({
        stopReason: undefined,
        assistantSaved: false,
        currentMsgId: 'm',
        lastSavedAssistantMsgId: null,
        iterationCount: 0,
        lastIterationInput: 0,
        lastIterationOutput: 0,
        lastIterationCacheRead: 0,
        lastIterationCacheWrite: 0,
        lastCostUsd: undefined,
        watchdogAborted: null,
        transientAbortVisibleSuppressed: false,
        toolCallsForTelemetry: 0,
        autoResume: false,
        queueLenBeforeDone: 0,
        oversizedPreflightRecoveryRequested: false,
        compactionSucceededThisTurn: false,
      }),
      estimateLiveContextTokens: () => 0,
      flushAssistantEvent: vi.fn(),
      flushAssistantDbUpdate: vi.fn(),
      flushDbWrites: vi.fn(async () => {}),
      trackDbWrite: vi.fn(async () => {}),
      markClosing,
      abortSession,
      setDone,
      wakeYieldLoop,
    });

    await terminalizer.forceTerminalizeRun('test', 'aborted');
    await terminalizer.forceTerminalizeRun('again', 'error');

    expect(markClosing).toHaveBeenCalledTimes(1);
    expect(markClosing).toHaveBeenCalledWith('forced:test');
    expect(abortSession).toHaveBeenCalledTimes(1);
    expect(setDone).toHaveBeenCalledTimes(1);
    expect(wakeYieldLoop).toHaveBeenCalledTimes(1);
    expect(eventQueue).toHaveLength(1);
    expect(eventQueue[0]).toMatchObject({ type: 'turn_done', usage: { stopReason: 'aborted' } });
    expect(terminalizer.isTerminalForced).toBe(true);
  });
});


describe('successful file presentation survives terminal response errors', () => {
  it('distinguishes successful presentation from failed final response without treating the run as success', async () => {
    const persistTerminalErrorNotice = vi.fn();
    const { terminalizer, eventQueue } = makeTerminalizer({
      persistTerminalErrorNotice,
      state: { stopReason: 'toolUse', assistantSaved: false, presentedFiles: ['/project/final/report.pdf'], providerErrorObservedThisTurn: true, providerErrorVisibleSurfacedThisTurn: false },
    });
    await terminalizer.emitTurnDone('error');
    expect(persistTerminalErrorNotice).toHaveBeenCalledWith(expect.stringContaining('파일 표시 요청은 완료'));
    expect(persistTerminalErrorNotice).toHaveBeenCalledWith(expect.stringContaining('마지막 AI 답변'));
    expect(eventQueue.find(event => event.type === 'turn_done')).toMatchObject({ usage: { stopReason: 'error' } });
  });
});
