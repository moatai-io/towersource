// Owns terminal turn_done emission and forced terminalization for Pi run loop.
// Public API: PiRunTerminalizer.

import type { EngineCallbacks, TowerMessage } from '../types.js';
import type { StuckReason } from '../pi-stream-watchdog.js';
import { getPiResponsesRequestDebugInfo } from './provider-safeguards.js';
import { classifyPiRunEndFailure, type PiRunEndTerminalizerReason } from './turn-metrics.js';
import type { PiRunContext } from './run-context.js';
import { buildPiContextSnapshot } from './run-context.js';
import type { AssistantContinuationIntentSummary } from './continuation-intent.js';
import { finalizeSessionWorkLedgerRecords } from '../../services/work/work-ledger.js';

const MAX_TRUSTED_ACCEPTED_AT_AGE_MS = 24 * 60 * 60 * 1000;

/** Use the durable root boundary only while it still represents a recoverable current turn. */
export function resolvePiTurnDurationMs(params: {
  acceptedAt?: string;
  nowMs: number;
  runDurationMs: number;
}): number {
  const acceptedAtMs = Date.parse(params.acceptedAt || '');
  const acceptedDurationMs = params.nowMs - acceptedAtMs;
  if (
    Number.isFinite(acceptedAtMs)
    && acceptedDurationMs >= 0
    && acceptedDurationMs <= MAX_TRUSTED_ACCEPTED_AT_AGE_MS
  ) {
    return acceptedDurationMs;
  }
  return Math.max(0, params.runDurationMs);
}

export interface PiRunTerminalizerState {
  stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
  assistantSaved: boolean;
  currentMsgId: string;
  lastSavedAssistantMsgId: string | null;
  iterationCount: number;
  lastIterationInput: number;
  lastIterationOutput: number;
  lastIterationCacheRead: number;
  lastIterationCacheWrite: number;
  lastIterationReasoning: number;
  lastCostUsd?: number;
  watchdogAborted: StuckReason | null;
  transientAbortVisibleSuppressed: boolean;
  toolCallsForTelemetry: number;
  autoResume: boolean;
  autoResumeReason?: string;
  queueLenBeforeDone: number;
  oversizedPreflightRecoveryRequested: boolean;
  compactionSucceededThisTurn: boolean;
  lastAssistant?: AssistantContinuationIntentSummary;
  providerErrorMessage?: string;
  terminalizerReason?: PiRunEndTerminalizerReason;
}

export class PiRunTerminalizer {
  private turnDoneFired = false;
  private terminalForced = false;
  private lastTerminalizerReason: PiRunEndTerminalizerReason = 'unknown_terminalizer';
  private lastProviderErrorMessage = '';

  constructor(private readonly params: {
    sessionId: string;
    runCtx: PiRunContext;
    /** Root request acceptance boundary; completion duration uses this when valid. */
    acceptedAt?: string;
    callbacks: Pick<EngineCallbacks, 'updateMessageMetrics'>;
    eventQueue: TowerMessage[];
    modelLabel: () => string;
    getState: () => PiRunTerminalizerState;
    estimateLiveContextTokens: () => number;
    flushAssistantEvent: () => void;
    flushAssistantDbUpdate: () => void;
    flushDbWrites: () => Promise<void>;
    trackDbWrite: (op: void | Promise<void>) => Promise<void>;
    markClosing?: (why: string, terminalStopOverride?: 'error' | 'aborted') => void;
    abortSession?: () => void;
    setDone?: () => void;
    wakeYieldLoop?: () => void;
    /** Shadow observation only; must not decide or delay Tower terminalization. */
    beforeTowerTerminal?: () => void;
    /** Current turn acceptance boundary for finalizing only ledger rows touched by this turn. */
    workLedgerTurnStartedAt?: string;
    finalizeWorkLedger?: typeof finalizeSessionWorkLedgerRecords;
  }) {}

  get hasTurnDoneFired(): boolean {
    return this.turnDoneFired;
  }

  get isTerminalForced(): boolean {
    return this.terminalForced;
  }

  async emitTurnDone(errorStopReason?: 'error' | 'aborted'): Promise<void> {
    const { sessionId, runCtx } = this.params;
    if (this.turnDoneFired) {
      console.log(`[Pi] turn_done already fired, skipping duplicate (errorStopReason=${errorStopReason ?? 'none'}): session=${sessionId.slice(0, 8)}`);
      return;
    }
    this.turnDoneFired = true;
    this.params.beforeTowerTerminal?.();

    this.params.flushAssistantEvent();
    this.params.flushAssistantDbUpdate();
    await this.params.flushDbWrites();

    const state = this.params.getState();
    this.lastTerminalizerReason = state.terminalizerReason ?? this.lastTerminalizerReason;
    this.lastProviderErrorMessage = state.providerErrorMessage ?? this.lastProviderErrorMessage;
    const durationMs = resolvePiTurnDurationMs({
      acceptedAt: this.params.acceptedAt,
      nowMs: Date.now(),
      runDurationMs: runCtx.durationMs,
    });
    const estimatedLiveContextInput = this.params.estimateLiveContextTokens();
    const actualContextInputTokens = runCtx.actualContextInputTokens();
    const riskContextEstimateTokens = runCtx.riskContextEstimateTokens(estimatedLiveContextInput);
    const compactReserveTokens = Number(process.env.PI_COMPACTION_RESERVE_TOKENS || 48_000);
    const compactThresholdTokens = Math.max(0, runCtx.modelContextWindow - compactReserveTokens);
    const requestDebugInfo = getPiResponsesRequestDebugInfo(sessionId);
    const nextRequestEstimatedTokens = requestDebugInfo?.bodyEstimatedPromptTokens;
    const contextSnapshot = buildPiContextSnapshot({
      actualTokens: actualContextInputTokens,
      requestTokens: nextRequestEstimatedTokens,
      estimatedTokens: riskContextEstimateTokens,
      windowTokens: runCtx.modelContextWindow,
    });
    const metricsMsgId = state.assistantSaved
      ? state.currentMsgId
      : (state.lastSavedAssistantMsgId || state.currentMsgId);

    if (state.iterationCount > 0) {
      this.params.trackDbWrite(this.params.callbacks.updateMessageMetrics(metricsMsgId, {
        durationMs,
        finalizeCompletedAt: true,
        inputTokens: state.lastIterationInput,
        outputTokens: state.lastIterationOutput,
        cacheReadTokens: state.lastIterationCacheRead,
        cacheCreationTokens: state.lastIterationCacheWrite,
        reasoningTokens: state.lastIterationReasoning,
        costUsd: state.lastCostUsd,
        contextInputTokens: actualContextInputTokens,
        contextWindowSize: runCtx.modelContextWindow,
        contextEstimatedTokens: riskContextEstimateTokens,
        nextRequestEstimatedTokens,
        compactThresholdTokens,
        contextSnapshot,
      }));
      await this.params.flushDbWrites();
    }

    const emptyQueuedCompletion = Boolean(
      !errorStopReason
      && state.iterationCount === 0
      && !state.assistantSaved
      && state.queueLenBeforeDone > 0
    );
    if (emptyQueuedCompletion) {
      console.warn(`[Pi] empty queued completion converted to recoverable error: session=${sessionId.slice(0, 8)} queueLen=${state.queueLenBeforeDone}`);
      this.params.eventQueue.push({
        type: 'engine_error',
        sessionId,
        message: '이전 실행이 비정상 종료된 뒤 대기 중이던 메시지를 처리하지 못했습니다. 빈 완료로 처리하지 않고 오류로 전환했습니다. 같은 요청을 새 턴으로 다시 보내주세요.',
        recoverable: true,
        retryable: true,
      });
    }
    const silentErrorCompletion = Boolean(
      !errorStopReason
      && state.stopReason === 'error'
      && !state.lastAssistant?.textTail
    );
    if (silentErrorCompletion) {
      const contextRecoveryFailed = state.oversizedPreflightRecoveryRequested || state.compactionSucceededThisTurn;
      console.warn(`[Pi] empty provider error converted to visible terminal error: session=${sessionId.slice(0, 8)} contextRecoveryFailed=${contextRecoveryFailed}`);
      this.params.eventQueue.push({
        type: 'engine_error',
        sessionId,
        message: contextRecoveryFailed
          ? '대화 컨텍스트가 너무 커서 자동 정리를 시도했지만 응답을 복구하지 못했습니다. 같은 세션에서 반복 재시도하지 말고 새 세션으로 작업을 이어가 주세요.'
          : 'AI 제공자 오류로 실행이 끝났지만 답변 텍스트가 생성되지 않았습니다. 빈 완료로 처리하지 않았습니다. 잠시 후 다시 시도하거나 새 세션에서 이어가 주세요.',
        recoverable: true,
        retryable: !contextRecoveryFailed,
      });
    }
    const effectiveErrorStopReason = errorStopReason || (emptyQueuedCompletion || silentErrorCompletion ? 'error' : undefined);
    const finalizeWorkLedger = this.params.finalizeWorkLedger ?? finalizeSessionWorkLedgerRecords;
    try {
      if (this.params.workLedgerTurnStartedAt) {
        await finalizeWorkLedger({
          sessionId,
          turnStartedAt: this.params.workLedgerTurnStartedAt,
          outcome: effectiveErrorStopReason ? 'failed' : 'completed',
        });
      }
    } catch (error: any) {
      console.warn(`[Pi] WorkLedger terminal finalization failed: session=${sessionId.slice(0, 8)} error=${error?.message || error}`);
    }
    const failureClass = classifyPiRunEndFailure({
      watchdogAborted: state.watchdogAborted,
      transientAbortVisibleSuppressed: state.transientAbortVisibleSuppressed,
      terminalForced: this.terminalForced,
      terminalizerReason: state.terminalizerReason ?? this.lastTerminalizerReason,
      providerErrorMessage: state.providerErrorMessage ?? this.lastProviderErrorMessage,
      errorStopReason: effectiveErrorStopReason,
    });
    const userFacingStopReason = effectiveErrorStopReason || (state.stopReason === 'toolUse' ? 'stop' : state.stopReason);
    const lastAssistant = state.lastAssistant;
    const continuationIntentWithoutTool = Boolean(
      !effectiveErrorStopReason &&
      userFacingStopReason === 'stop' &&
      lastAssistant?.continuationIntent &&
      !lastAssistant.hasToolCall,
    );
    const lastAssistantTelemetry = lastAssistant
      ? ` lastStop=${lastAssistant.stopReason ?? 'none'} lastBlocks=${lastAssistant.blockTypes.join(',') || 'none'} lastHadTool=${lastAssistant.hasToolCall} continuationIntent=${lastAssistant.continuationIntent}${lastAssistant.matchedPattern ? ` continuationPattern=${lastAssistant.matchedPattern}` : ''} textTail=${JSON.stringify(lastAssistant.textTail)}`
      : ' lastStop=none lastBlocks=none lastHadTool=false continuationIntent=false textTail=""';
    console.log(`[PiRunSummary] session=${sessionId.slice(0, 8)} model=${this.params.modelLabel()} final=${effectiveErrorStopReason || 'complete'}${failureClass ? ` failure=${failureClass}` : ''} terminalizerReason=${this.lastTerminalizerReason} providerError=${JSON.stringify(this.lastProviderErrorMessage || '')} iterations=${state.iterationCount} tools=${state.toolCallsForTelemetry} autoResume=${state.autoResume}${state.autoResumeReason ? ` autoResumeReason=${state.autoResumeReason}` : ''} terminalForced=${this.terminalForced} suppressed=${state.transientAbortVisibleSuppressed} oversizedPreflightRecoveryRequested=${state.oversizedPreflightRecoveryRequested} compactionSucceeded=${state.compactionSucceededThisTurn} queueLenBeforeDone=${state.queueLenBeforeDone}${lastAssistantTelemetry} ctxActual=${actualContextInputTokens}/${runCtx.modelContextWindow} ctxRisk=${riskContextEstimateTokens}/${runCtx.modelContextWindow} durationMs=${durationMs}`);
    if (continuationIntentWithoutTool) {
      console.warn(`[Pi] continuation intent without tool call: session=${sessionId.slice(0, 8)} pattern=${lastAssistant?.matchedPattern ?? 'unknown'} textTail=${JSON.stringify(lastAssistant?.textTail ?? '')}`);
    }

    const completedAfterToolWithoutFinalText = Boolean(
      !effectiveErrorStopReason
      && userFacingStopReason === 'stop'
      && lastAssistant?.hasToolCall
      && !lastAssistant.textTail,
    );
    if (completedAfterToolWithoutFinalText) {
      console.warn(`[Pi] completed after tool call without final assistant text: session=${sessionId.slice(0, 8)} lastBlocks=${lastAssistant?.blockTypes.join(',') || 'none'}`);
      this.params.eventQueue.push({
        type: 'engine_error',
        sessionId,
        message: '모델 실행은 끝났지만 자동 continuation 후에도 최종 답변 텍스트가 비어 있습니다. 도구 실행 결과는 저장됐으며, 중복 실행을 막기 위해 자동 재시도는 여기서 중단했습니다.',
        recoverable: true,
        retryable: true,
      });
    }

    this.params.eventQueue.push({
      type: 'turn_done',
      sessionId,
      msgId: metricsMsgId,
      assistantMsgIds: runCtx.assistantMsgIdsThisTurn,
      timestamp: Date.now(),
      usage: runCtx.usageSummary({
        durationMs,
        stopReason: userFacingStopReason,
        contextInputTokens: actualContextInputTokens,
        contextEstimatedTokens: riskContextEstimateTokens,
        nextRequestEstimatedTokens,
        compactThresholdTokens,
      }),
    });
  }

  async forceTerminalizeRun(why: string, stop: 'error' | 'aborted' = 'error'): Promise<void> {
    if (this.terminalForced) return;
    this.terminalForced = true;
    this.params.markClosing?.(`forced:${why}`);
    console.warn(`[Pi] force terminalizing run: session=${this.params.sessionId.slice(0, 8)} why=${why} stop=${stop}`);
    this.params.abortSession?.();
    await this.emitTurnDone(stop);
    this.params.setDone?.();
    this.params.wakeYieldLoop?.();
  }
}
