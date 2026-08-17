// Owns: transcript visibility and assistant-merge policy for agent/subagent messages.
// Public API: isAgentOriginMessage, getVisibleChatMessages, mergeConsecutiveAssistant.
// See README.md and _DECISIONS.md.

import type { ChatMessage } from '../../stores/chat-store';

export function isAgentOriginMessage(msg: ChatMessage): boolean {
  const meta = msg.metadata as any;
  return meta?.sourceType === 'agent_wake'
    || meta?.sourceType === 'agent_send'
    || meta?.sourceType === 'agent_spawn'
    || !!meta?.agentWake
    || !!meta?.agentSend;
}

export function isAgentReportMessage(msg: ChatMessage): boolean {
  return (msg.metadata as any)?.sourceType === 'agent_report'
    || !!(msg.metadata as any)?.agentReport
    || msg.content.some((b) => b.type === 'agent_run');
}

export function isCompactAgentReportMessage(msg: ChatMessage): boolean {
  return (msg.metadata as any)?.sourceType === 'agent_report'
    || !!(msg.metadata as any)?.agentReport;
}

export function shouldHideAgentReportBubble(msg: ChatMessage): boolean {
  return isCompactAgentReportMessage(msg);
}

export function getVisibleChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((msg) => {
    if (msg.metadata?.hidden) return false;
    if (isCompactAgentReportMessage(msg)) return false;
    if (msg.parentToolUseId) return false;
    if (msg.role !== 'user') return true;
    if (msg.content.length > 0 && msg.content.every((b) => b.type === 'tool_result')) {
      return false;
    }
    const firstText = msg.content.find((b) => b.type === 'text')?.text || '';
    if (firstText.startsWith('Base directory for this skill:')) return false;
    if (firstText.startsWith('<session-start-hook>')) return false;
    return true;
  });
}

export function canMergeAssistantMessages(last: ChatMessage | undefined, msg: ChatMessage): boolean {
  return !!last
    && last.role === 'assistant'
    && msg.role === 'assistant'
    && !isAgentReportMessage(last)
    && !isAgentReportMessage(msg)
    && (last.parentToolUseId ?? null) === (msg.parentToolUseId ?? null);
}

function isNonTerminalTextOnlyAssistant(msg: ChatMessage | undefined): boolean {
  return !!msg
    && msg.role === 'assistant'
    && !msg.completedAt
    && msg.content.length > 0
    && msg.content.every((block) => block.type === 'text');
}

export function mergeConsecutiveAssistant(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];

  for (const msg of messages) {
    const last = result[result.length - 1];
    if (canMergeAssistantMessages(last, msg)) {
      const previousContent = isNonTerminalTextOnlyAssistant(last) && !!msg.completedAt
        ? []
        : last.content;
      result[result.length - 1] = {
        ...last,
        content: [...previousContent, ...msg.content],
        updatedAt: msg.updatedAt ?? last.updatedAt,
        completedAt: msg.completedAt ?? last.completedAt,
        durationMs: msg.durationMs ?? last.durationMs,
        inputTokens: msg.inputTokens ?? last.inputTokens,
        outputTokens: msg.outputTokens ?? last.outputTokens,
        reasoningTokens: msg.reasoningTokens ?? last.reasoningTokens,
        contextWindowSize: msg.contextWindowSize ?? last.contextWindowSize,
        stopReason: msg.stopReason ?? last.stopReason,
      };
    } else {
      result.push({ ...msg, content: [...msg.content] });
    }
  }

  return result;
}
