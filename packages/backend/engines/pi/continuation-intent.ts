// Owns conservative detection of assistant turns that ended at a real tool boundary.
// Public API: summarizeAssistantContinuationIntent.

import type { TowerContentBlock } from '../types.js';

export interface AssistantContinuationIntentSummary {
  stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
  blockTypes: string[];
  hasToolCall: boolean;
  textTail: string;
  textAfterLastToolCall: string;
  continuationIntent: boolean;
  matchedPattern?: string;
}

/**
 * Returns true when a nominally completed Pi turn stopped at a concrete tool
 * boundary and still owes the user a final response. Do not infer this from
 * prose such as “확인하겠습니다”: that is too brittle and creates duplicate
 * answers when the text was already a usable final response.
 */
export function shouldAutoContinueIncompleteTurn(params: {
  stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
  lastAssistant?: AssistantContinuationIntentSummary;
  abortRequested: boolean;
  watchdogAborted: boolean;
}): boolean {
  if (params.abortRequested || params.watchdogAborted) return false;
  if (params.stopReason === 'error' || params.stopReason === 'aborted' || params.stopReason === 'length') return false;

  const lastAssistant = params.lastAssistant;
  if (!lastAssistant) return false;

  return lastAssistant.hasToolCall && !lastAssistant.textAfterLastToolCall;
}

function normalizeTail(text: string, maxChars: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(-maxChars);
}

export function summarizeAssistantContinuationIntent(params: {
  stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
  content: TowerContentBlock[];
  tailChars?: number;
}): AssistantContinuationIntentSummary {
  const blockTypes = params.content.map(block => block.type);
  const lastToolIndex = params.content.map(block => block.type).lastIndexOf('tool_use');
  const hasToolCall = lastToolIndex >= 0;
  const text = params.content
    .filter((block): block is Extract<TowerContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n');
  const textAfterLastToolCall = hasToolCall
    ? normalizeTail(params.content
        .slice(lastToolIndex + 1)
        .filter((block): block is Extract<TowerContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n'), params.tailChars ?? 200)
    : '';
  const textTail = normalizeTail(text, params.tailChars ?? 200);

  return {
    stopReason: params.stopReason,
    blockTypes,
    hasToolCall,
    textTail,
    textAfterLastToolCall,
    continuationIntent: false,
  };
}
