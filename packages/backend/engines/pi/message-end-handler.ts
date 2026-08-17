// Owns low-risk message_end event analysis for the Pi run loop.
// Public API: analyzePiMessageEndCore.

import type { TowerContentBlock } from '../types.js';
import { agentMessageToTowerBlocks } from './message-adapter.js';
import { chooseAssistantContentToSave, shouldApplyMessageStopReason, type PiStopReason } from './message-end-policy.js';

export interface PiMessageEndCoreAnalysis {
  usage: any;
  msgStopReason?: PiStopReason;
  msgContentLen: number;
  shouldApplyStopReason: boolean;
  providerErrorText?: string;
  assistantContent?: {
    finalContent: TowerContentBlock[];
    contentToSave: TowerContentBlock[];
    shouldReplaceAccumulator: boolean;
  };
}

export function analyzePiMessageEndCore(params: {
  msg: any;
  previousStopReason?: PiStopReason;
  accumulatorContent: TowerContentBlock[];
}): PiMessageEndCoreAnalysis {
  const { msg, previousStopReason, accumulatorContent } = params;
  const usage = msg?.usage;
  const msgStopReason = msg?.stopReason as PiStopReason | undefined;
  const msgContentLen = Array.isArray(msg?.content) ? msg.content.length : 0;
  const providerErrorText = msgStopReason === 'error' && msg?.errorMessage
    ? String(msg.errorMessage)
    : undefined;

  let assistantContent: PiMessageEndCoreAnalysis['assistantContent'];
  if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
    const finalContent = agentMessageToTowerBlocks(msg);
    assistantContent = {
      finalContent,
      contentToSave: chooseAssistantContentToSave({ finalContent, accumulatorContent }),
      shouldReplaceAccumulator: finalContent.length > 0,
    };
  }

  return {
    usage,
    msgStopReason,
    msgContentLen,
    shouldApplyStopReason: shouldApplyMessageStopReason({
      msgStopReason,
      msgContentLen,
      previousStopReason,
    }),
    providerErrorText,
    assistantContent,
  };
}
