/**
 * Owns: per-turn mutable state for PiEngine.run(). Public API: PiRunContext.
 * See RUN_LOOP_EXTRACTION_PLAN.md.
 */

import crypto from 'crypto';
import type { TowerContentBlock } from '../types.js';
import { ContentAccumulator } from './message-adapter.js';
import { extractPiUsageDelta } from './message-end-policy.js';
import { chooseContextRiskEstimateTokens, normalizeIterationCount } from './turn-metrics.js';

export interface PiContextSnapshot {
  actualTokens?: number;
  requestTokens?: number;
  estimatedTokens?: number;
  windowTokens: number;
  actualSource: 'provider' | 'cache-reconstructed' | 'none';
  requestSource: 'sanitized-request' | 'none';
  capturedAt: string;
  terminal: boolean;
}

export function buildPiContextSnapshot(params: {
  actualTokens: number;
  actualSource?: 'provider' | 'cache-reconstructed';
  requestTokens?: number;
  estimatedTokens: number;
  windowTokens: number;
  capturedAt?: string;
}): PiContextSnapshot {
  const actualTokens = Number.isFinite(params.actualTokens) && params.actualTokens > 0
    ? params.actualTokens
    : undefined;
  const requestTokens = Number.isFinite(params.requestTokens) && Number(params.requestTokens) > 0
    ? Number(params.requestTokens)
    : undefined;
  const estimatedTokens = Number.isFinite(params.estimatedTokens) && params.estimatedTokens > 0
    ? params.estimatedTokens
    : undefined;

  return {
    actualTokens,
    requestTokens,
    estimatedTokens,
    windowTokens: Math.max(0, params.windowTokens),
    actualSource: actualTokens ? (params.actualSource ?? 'provider') : 'none',
    requestSource: requestTokens ? 'sanitized-request' : 'none',
    capturedAt: params.capturedAt ?? new Date().toISOString(),
    terminal: true,
  };
}

export interface PiRunUsageDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  costUsd?: number;
}

export interface PiRunUsageSummary {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  durationMs: number;
  stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
  contextInputTokens: number;
  contextOutputTokens: number;
  contextWindowSize: number;
  contextEstimatedTokens?: number;
  nextRequestEstimatedTokens?: number;
  compactThresholdTokens?: number;
  numIterations: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
}

export class PiRunContext {
  accumulator = new ContentAccumulator();
  msgId: string;
  assistantSaved = false;
  lastSavedAssistantMsgId: string | null = null;
  assistantMsgIdsThisTurn: string[] = [];

  iterationCount = 0;
  cumulativeInput = 0;
  cumulativeOutput = 0;
  lastIterationInput = 0;
  lastIterationOutput = 0;
  cumulativeCacheRead = 0;
  cumulativeCacheWrite = 0;
  cumulativeReasoning = 0;
  lastIterationCacheRead = 0;
  lastIterationCacheWrite = 0;
  lastIterationReasoning = 0;
  cumulativeCostUsd = 0;
  lastCostUsd: number | undefined;
  compactionSucceededThisTurn = false;

  constructor(private readonly params: {
    modelContextWindow: number;
    turnStartTime?: number;
    makeId?: () => string;
    initialMsgId?: string;
  }) {
    this.msgId = params.initialMsgId ?? this.makeId();
  }

  get turnStartTime(): number {
    return this.params.turnStartTime ?? 0;
  }

  get modelContextWindow(): number {
    return this.params.modelContextWindow;
  }

  get durationMs(): number {
    if (!this.params.turnStartTime) return 0;
    return Date.now() - this.params.turnStartTime;
  }

  markAssistantSaved(id = this.msgId): void {
    this.assistantSaved = true;
    this.lastSavedAssistantMsgId = id;
    if (!this.assistantMsgIdsThisTurn.includes(id)) this.assistantMsgIdsThisTurn.push(id);
  }

  chooseMetricsMsgId(): string {
    return this.assistantSaved ? this.msgId : (this.lastSavedAssistantMsgId || this.msgId);
  }

  rotateAssistantIteration(): void {
    this.msgId = this.makeId();
    this.accumulator = new ContentAccumulator();
    this.assistantSaved = false;
  }

  recordUsage(usage: unknown): PiRunUsageDelta {
    this.iterationCount++;
    const delta = extractPiUsageDelta(usage);
    this.cumulativeInput += delta.input;
    this.cumulativeOutput += delta.output;
    this.cumulativeCacheRead += delta.cacheRead;
    this.cumulativeCacheWrite += delta.cacheWrite;
    this.cumulativeReasoning += delta.reasoning;
    if (typeof delta.costUsd === 'number') this.cumulativeCostUsd += delta.costUsd;
    this.lastIterationInput = delta.input;
    this.lastIterationOutput = delta.output;
    this.lastIterationCacheRead = delta.cacheRead;
    this.lastIterationCacheWrite = delta.cacheWrite;
    this.lastIterationReasoning = delta.reasoning;
    this.lastCostUsd = delta.costUsd;
    return delta;
  }

  actualContextInputTokens(): number {
    return this.lastIterationInput + this.lastIterationCacheRead + this.lastIterationCacheWrite;
  }

  riskContextEstimateTokens(estimatedLiveContextInput: number): number {
    return chooseContextRiskEstimateTokens({
      compactionSucceededThisTurn: this.compactionSucceededThisTurn,
      estimatedLiveContextInput,
      actualContextInput: this.actualContextInputTokens(),
    });
  }

  usageSummary(params: {
    durationMs: number;
    stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
    contextInputTokens: number;
    contextEstimatedTokens?: number;
    nextRequestEstimatedTokens?: number;
    compactThresholdTokens?: number;
  }): PiRunUsageSummary {
    return {
      inputTokens: this.cumulativeInput,
      outputTokens: this.cumulativeOutput,
      costUsd: this.cumulativeCostUsd || this.lastCostUsd,
      durationMs: params.durationMs,
      stopReason: params.stopReason,
      contextInputTokens: params.contextInputTokens,
      contextOutputTokens: this.lastIterationOutput,
      contextWindowSize: this.modelContextWindow,
      contextEstimatedTokens: params.contextEstimatedTokens,
      nextRequestEstimatedTokens: params.nextRequestEstimatedTokens,
      compactThresholdTokens: params.compactThresholdTokens,
      numIterations: normalizeIterationCount(this.iterationCount),
      cacheReadTokens: this.cumulativeCacheRead,
      cacheCreationTokens: this.cumulativeCacheWrite,
      reasoningTokens: this.cumulativeReasoning,
    };
  }

  replaceAccumulator(content: TowerContentBlock[]): void {
    this.accumulator.replaceAll(content);
  }

  accumulatorBlocks(): TowerContentBlock[] {
    return this.accumulator.toTowerBlocks();
  }

  private makeId(): string {
    return this.params.makeId?.() ?? crypto.randomUUID();
  }
}
