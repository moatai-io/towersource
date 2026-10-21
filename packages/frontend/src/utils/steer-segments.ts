import type { ChatMessage, ContentBlock } from '../stores/chat-store';

interface SteerBoundary {
  id: string;
  text: string;
  username?: string;
  assistantMsgId: string;
  assistantContent: ContentBlock[];
  timestamp: number;
}

function sameBlockIdentity(a: ContentBlock, b: ContentBlock): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'tool_use') return a.toolUse?.id === b.toolUse?.id;
  return true;
}

function contentAfterPrefix(full: ContentBlock[], prefix: ContentBlock[]): ContentBlock[] {
  let index = 0;
  for (; index < prefix.length && index < full.length; index += 1) {
    const before = prefix[index];
    const current = full[index];
    if (!sameBlockIdentity(current, before)) return full;
    const beforeText = before.text ?? before.thinking?.text ?? '';
    const currentText = current.text ?? current.thinking?.text ?? '';
    if (beforeText && currentText.startsWith(beforeText) && currentText !== beforeText) {
      const suffix = currentText.slice(beforeText.length);
      const split = current.type === 'thinking'
        ? { ...current, thinking: { ...current.thinking, text: suffix } }
        : { ...current, text: suffix };
      return [split, ...full.slice(index + 1)];
    }
    if (JSON.stringify(current) !== JSON.stringify(before)) return full;
  }
  return full.slice(index);
}

function boundariesFromMessage(message: ChatMessage): SteerBoundary[] {
  const items = Array.isArray(message.metadata?.steerItems) ? message.metadata.steerItems : null;
  if (items) {
    return items.flatMap((item: any, index: number) => item?.assistantMsgId && Array.isArray(item?.assistantContent) ? [{
      id: item.id,
      text: item.text ?? '',
      username: message.username,
      assistantMsgId: item.assistantMsgId,
      assistantContent: item.assistantContent,
      timestamp: message.timestamp + index,
    }] : []);
  }
  const delivery = message.metadata?.steerDelivery;
  if (!delivery?.assistantMsgId || !Array.isArray(delivery.assistantContent)) return [];
  return [{
    id: message.id,
    text: message.content.find((block) => block.type === 'text')?.text ?? '',
    username: message.username,
    assistantMsgId: delivery.assistantMsgId,
    assistantContent: delivery.assistantContent,
    timestamp: message.timestamp,
  }];
}

export function segmentMessagesAroundDeliveredSteers(messages: ChatMessage[]): ChatMessage[] {
  const boundaries = messages.flatMap(boundariesFromMessage);
  if (boundaries.length === 0) return messages;
  const boundaryIds = new Set(boundaries.map((boundary) => boundary.id));
  const byAssistant = new Map<string, SteerBoundary[]>();
  for (const boundary of boundaries) {
    const list = byAssistant.get(boundary.assistantMsgId) ?? [];
    list.push(boundary);
    byAssistant.set(boundary.assistantMsgId, list);
  }

  return messages.flatMap((message) => {
    if (message.role === 'user' && (boundaryIds.has(message.id)
      || (Array.isArray(message.metadata?.steerIds) && message.metadata.steerIds.some((id: string) => boundaryIds.has(id))))) {
      return [];
    }
    const steers = byAssistant.get(message.id);
    if (message.role !== 'assistant' || !steers?.length) return [message];

    const ordered = [...steers].sort((a, b) => a.assistantContent.length - b.assistantContent.length || a.timestamp - b.timestamp);
    const out: ChatMessage[] = [];
    let previous: ContentBlock[] = [];
    ordered.forEach((steer, index) => {
      const segment = contentAfterPrefix(steer.assistantContent, previous);
      if (segment.length) out.push({
        ...message,
        id: `${message.id}:segment:${index}`,
        content: segment,
        durationMs: undefined,
        inputTokens: undefined,
        outputTokens: undefined,
        reasoningTokens: undefined,
        completedAt: undefined,
        metadata: { ...message.metadata, assistantSegmentOf: message.id },
      });
      out.push({
        id: steer.id,
        role: 'user',
        content: [{ type: 'text', text: steer.text }],
        timestamp: steer.timestamp,
        username: steer.username,
        sendStatus: 'delivered',
        metadata: { kind: 'pi-steer-segment', assistantMsgId: message.id },
      });
      previous = steer.assistantContent;
    });
    const tail = contentAfterPrefix(message.content, previous);
    if (tail.length) out.push({ ...message, content: tail });
    return out;
  });
}
