import type { ChatMessage } from '../stores/chat-store';
import { ByteBudgetLru } from './byte-budget-lru';

export const SESSION_MESSAGE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
export const SESSION_MESSAGE_CACHE_MAX_ENTRIES = 50;

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

function utf8Bytes(value: string): number {
  if (textEncoder) return textEncoder.encode(value).byteLength;
  return value.length * 2;
}

/** JSON size is a stable lower-cost proxy for retained message graph memory. */
export function estimateSessionMessagesBytes(messages: ChatMessage[]): number {
  try {
    return utf8Bytes(JSON.stringify(messages));
  } catch {
    return messages.reduce((total, message) => {
      let contentBytes = 0;
      for (const block of message.content ?? []) {
        contentBytes += utf8Bytes(block.text ?? '');
        contentBytes += utf8Bytes(block.thinking?.text ?? '');
        contentBytes += utf8Bytes(block.toolUse?.result ?? '');
        try { contentBytes += utf8Bytes(JSON.stringify(block.toolUse?.input ?? {})); } catch {}
      }
      return total + 256 + utf8Bytes(message.id) + contentBytes;
    }, 0);
  }
}

export const sessionMsgCache = new ByteBudgetLru<string, ChatMessage[]>({
  maxBytes: SESSION_MESSAGE_CACHE_MAX_BYTES,
  maxEntries: SESSION_MESSAGE_CACHE_MAX_ENTRIES,
  estimateSize: estimateSessionMessagesBytes,
});

export function cacheSessionMessages(sessionId: string, messages: ChatMessage[]): void {
  sessionMsgCache.set(sessionId, messages, sessionId);
}
