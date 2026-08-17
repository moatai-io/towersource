// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { loadQueueFromStorage, useChatStore } from './chat-store';

const QUEUE_STORAGE_KEY = 'tower:messageQueue';

describe('chat message queue lifecycle', () => {
  beforeEach(() => {
    localStorage.clear();
    useChatStore.setState({ messageQueue: {} });
  });

  it('discards a legacy persisted queue instead of replaying it after reload', () => {
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify({
      'session-old': ['TST에 업로드할 aml 파일을 생성해줘.'],
    }));

    expect(loadQueueFromStorage()).toEqual({});
    expect(localStorage.getItem(QUEUE_STORAGE_KEY)).toBeNull();
  });

  it('keeps a current-page queue in memory without persisting executable text', () => {
    useChatStore.getState().enqueueMessage('session-live', '현재 turn 뒤에 실행');

    expect(useChatStore.getState().messageQueue['session-live']).toEqual(['현재 turn 뒤에 실행']);
    expect(localStorage.getItem(QUEUE_STORAGE_KEY)).toBeNull();
  });

  it('still drains the in-memory queue in FIFO order during the current page lifetime', () => {
    useChatStore.getState().enqueueMessage('session-live', '첫 번째');
    useChatStore.getState().enqueueMessage('session-live', '두 번째');

    expect(useChatStore.getState().dequeueMessage('session-live')).toBe('첫 번째');
    expect(useChatStore.getState().dequeueMessage('session-live')).toBe('두 번째');
    expect(useChatStore.getState().dequeueMessage('session-live')).toBeNull();
  });
});
