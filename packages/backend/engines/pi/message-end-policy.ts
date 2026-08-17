// Owns pure message_end policy decisions for the Pi run loop.
// Public API: shouldApplyMessageStopReason, extractPiUsageDelta, chooseAssistantContentToSave.

import type { TowerContentBlock } from '../types.js';

export type PiStopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';

export interface PiUsageDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  costUsd?: number;
}

export function shouldApplyMessageStopReason(params: {
  msgStopReason?: PiStopReason;
  msgContentLen: number;
  previousStopReason?: PiStopReason;
}): boolean {
  const isEmptyErrorMsg = params.msgStopReason === 'error' && params.msgContentLen === 0;
  return !!params.msgStopReason && !(isEmptyErrorMsg && !!params.previousStopReason);
}

export function extractPiUsageDelta(usage: any): PiUsageDelta {
  const reasoning =
    usage?.reasoningTokens
    ?? usage?.reasoning
    ?? usage?.outputTokensDetails?.reasoningTokens
    ?? usage?.output_tokens_details?.reasoning_tokens
    ?? usage?.completion_tokens_details?.reasoning_tokens
    ?? 0;
  return {
    input: usage?.input || 0,
    output: usage?.output || 0,
    cacheRead: usage?.cacheRead || 0,
    cacheWrite: usage?.cacheWrite || 0,
    reasoning: Number.isFinite(Number(reasoning)) ? Number(reasoning) : 0,
    costUsd: usage?.cost?.total,
  };
}

export function chooseAssistantContentToSave(params: {
  finalContent: TowerContentBlock[];
  accumulatorContent: TowerContentBlock[];
}): TowerContentBlock[] {
  return params.finalContent.length > 0 ? params.finalContent : params.accumulatorContent;
}
