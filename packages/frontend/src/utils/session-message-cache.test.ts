import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../stores/chat-store';
import {
  cacheSessionMessages,
  estimateSessionMessagesBytes,
  sessionMsgCache,
  SESSION_MESSAGE_CACHE_MAX_BYTES,
} from './session-message-cache';

function message(text: string): ChatMessage {
  return {
    id: `m-${text.length}`,
    role: 'assistant',
    timestamp: 1,
    content: [{ type: 'text', text }],
  };
}

describe('session message cache', () => {
  beforeEach(() => sessionMsgCache.clear());

  it('estimates larger transcripts as larger byte usage', () => {
    expect(estimateSessionMessagesBytes([message('긴 텍스트'.repeat(100))]))
      .toBeGreaterThan(estimateSessionMessagesBytes([message('짧음')]));
  });

  it('stores ordinary transcripts and refreshes recency on get', () => {
    cacheSessionMessages('a', [message('a')]);
    cacheSessionMessages('b', [message('b')]);
    expect(sessionMsgCache.get('a')?.[0].content[0].text).toBe('a');
    expect([...sessionMsgCache.keys()]).toEqual(['b', 'a']);
  });

  it('does not cache a single transcript larger than the budget', () => {
    cacheSessionMessages('huge', [message('x'.repeat(SESSION_MESSAGE_CACHE_MAX_BYTES + 1))]);
    expect(sessionMsgCache.has('huge')).toBe(false);
    expect(sessionMsgCache.totalBytes).toBe(0);
  });
});
