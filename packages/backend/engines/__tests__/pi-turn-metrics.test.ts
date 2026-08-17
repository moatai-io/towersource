import { describe, expect, it } from 'vitest';
import { shouldAutoContinueIncompleteTurn, summarizeAssistantContinuationIntent } from '../pi/continuation-intent.js';
import { classifyPiRunEndFailure, chooseContextRiskEstimateTokens, normalizeIterationCount } from '../pi/turn-metrics.js';

describe('Pi turn metrics helpers', () => {
  it('prefers post-compaction live context when compaction succeeded', () => {
    expect(chooseContextRiskEstimateTokens({
      compactionSucceededThisTurn: true,
      estimatedLiveContextInput: 42_000,
      actualContextInput: 3_000_000,
    })).toBe(42_000);
  });

  it('otherwise uses the larger of provider last input and live context estimate', () => {
    expect(chooseContextRiskEstimateTokens({
      compactionSucceededThisTurn: false,
      estimatedLiveContextInput: 80_000,
      actualContextInput: 50_000,
    })).toBe(80_000);

    expect(chooseContextRiskEstimateTokens({
      compactionSucceededThisTurn: false,
      estimatedLiveContextInput: 10_000,
      actualContextInput: 50_000,
    })).toBe(50_000);
  });

  it('does not trust zero live context just because compaction flag is set', () => {
    expect(chooseContextRiskEstimateTokens({
      compactionSucceededThisTurn: true,
      estimatedLiveContextInput: 0,
      actualContextInput: 50_000,
    })).toBe(50_000);
  });

  it('keeps turn iteration count at least one', () => {
    expect(normalizeIterationCount(0)).toBe(1);
    expect(normalizeIterationCount(3)).toBe(3);
  });

  it('does not infer continuation from text-only promises', () => {
    const summary = summarizeAssistantContinuationIntent({
      stopReason: 'stop',
      content: [{ type: 'text', text: '분석 문서를 저장했습니다. 이제 다음으로 실제 파일을 확인해보겠습니다.' }],
    });

    expect(summary.continuationIntent).toBe(false);
    expect(summary.hasToolCall).toBe(false);
    expect(summary.blockTypes).toEqual(['text']);
    expect(summary.textTail).toContain('확인해보겠습니다');
    expect(summary.textAfterLastToolCall).toBe('');
  });

  it('detects whether a tool boundary has final text after it', () => {
    const toolBoundary = summarizeAssistantContinuationIntent({
      stopReason: 'toolUse',
      content: [
        { type: 'text', text: '이제 확인해보겠습니다.' },
        { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'foo.txt' } },
      ],
    });

    expect(toolBoundary.continuationIntent).toBe(false);
    expect(toolBoundary.hasToolCall).toBe(true);
    expect(toolBoundary.blockTypes).toEqual(['text', 'tool_use']);
    expect(toolBoundary.textAfterLastToolCall).toBe('');

    const finalAfterTool = summarizeAssistantContinuationIntent({
      stopReason: 'stop',
      content: [
        { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'foo.txt' } },
        { type: 'text', text: '확인 결과 문제가 없습니다.' },
      ],
    });

    expect(finalAfterTool.textAfterLastToolCall).toContain('문제가 없습니다');
  });

  it('auto-continues only real tool-boundary completions without replaying aborts', () => {
    expect(shouldAutoContinueIncompleteTurn({
      stopReason: 'stop',
      lastAssistant: {
        stopReason: 'toolUse',
        blockTypes: ['tool_use'],
        hasToolCall: true,
        textTail: '',
        textAfterLastToolCall: '',
        continuationIntent: false,
      },
      abortRequested: false,
      watchdogAborted: false,
    })).toBe(true);

    expect(shouldAutoContinueIncompleteTurn({
      stopReason: 'stop',
      lastAssistant: {
        stopReason: 'stop',
        blockTypes: ['text'],
        hasToolCall: false,
        textTail: '이제 테스트를 진행하겠습니다.',
        textAfterLastToolCall: '',
        continuationIntent: true,
      },
      abortRequested: false,
      watchdogAborted: false,
    })).toBe(false);

    expect(shouldAutoContinueIncompleteTurn({
      stopReason: 'stop',
      lastAssistant: {
        stopReason: 'stop',
        blockTypes: ['tool_use', 'text'],
        hasToolCall: true,
        textTail: '확인 결과 문제 없습니다.',
        textAfterLastToolCall: '확인 결과 문제 없습니다.',
        continuationIntent: false,
      },
      abortRequested: false,
      watchdogAborted: false,
    })).toBe(false);

    expect(shouldAutoContinueIncompleteTurn({
      stopReason: 'aborted',
      lastAssistant: {
        stopReason: 'toolUse',
        blockTypes: ['tool_use'],
        hasToolCall: true,
        textTail: '',
        textAfterLastToolCall: '',
        continuationIntent: false,
      },
      abortRequested: true,
      watchdogAborted: false,
    })).toBe(false);
  });

  it('classifies run-end failure causes by priority', () => {
    expect(classifyPiRunEndFailure({
      watchdogAborted: 'text-stuck',
      transientAbortVisibleSuppressed: true,
      terminalForced: true,
      errorStopReason: 'error',
    })).toBe('watchdog_stuck');

    expect(classifyPiRunEndFailure({
      watchdogAborted: null,
      transientAbortVisibleSuppressed: true,
      terminalForced: true,
      errorStopReason: 'error',
      terminalizerReason: 'transient_transport',
    })).toBe('transient_transport');

    expect(classifyPiRunEndFailure({
      watchdogAborted: null,
      transientAbortVisibleSuppressed: false,
      terminalForced: true,
      errorStopReason: 'error',
      terminalizerReason: 'sdk_zombie',
    })).toBe('sdk_zombie');

    expect(classifyPiRunEndFailure({
      watchdogAborted: null,
      transientAbortVisibleSuppressed: false,
      terminalForced: true,
      errorStopReason: 'error',
      providerErrorMessage: 'upstream_error: Service Unavailable',
    })).toBe('unknown_fatal');

    expect(classifyPiRunEndFailure({
      watchdogAborted: null,
      transientAbortVisibleSuppressed: false,
      terminalForced: false,
      errorStopReason: 'aborted',
    })).toBeUndefined();
  });
});
