// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentBlock } from './chat-store';
import { useChatStore } from './chat-store';

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }];
}

describe('chat-store streaming update batching', () => {
  const rafCallbacks: FrameRequestCallback[] = [];

  beforeEach(() => {
    rafCallbacks.length = 0;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    useChatStore.setState({ messages: [], sessionId: 'stream-session' });
  });

  afterEach(() => {
    useChatStore.getState().flushAssistantUpdates();
    vi.unstubAllGlobals();
  });

  it('coalesces a burst into one store commit with the latest cumulative content', () => {
    useChatStore.getState().addMessage({ id: 'assistant-1', role: 'assistant', content: [], timestamp: 1 });
    let commits = 0;
    const unsubscribe = useChatStore.subscribe((state, previous) => {
      if (state.messages !== previous.messages) commits += 1;
    });

    for (let index = 1; index <= 100; index += 1) {
      useChatStore.getState().updateAssistantById('assistant-1', text('x'.repeat(index)), index);
    }

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(commits).toBe(0);
    rafCallbacks.shift()?.(performance.now());

    expect(commits).toBe(1);
    expect(useChatStore.getState().messages[0].content[0].text).toHaveLength(100);
    expect(useChatStore.getState().messages[0].timestamp).toBe(100);
    unsubscribe();
  });

  it('flushes the latest content synchronously at a terminal boundary', () => {
    useChatStore.getState().addMessage({ id: 'assistant-2', role: 'assistant', content: [], timestamp: 1 });
    useChatStore.getState().updateAssistantById('assistant-2', text('final cumulative response'), 42);

    useChatStore.getState().flushAssistantUpdates();

    expect(useChatStore.getState().messages[0].content[0].text).toBe('final cumulative response');
    expect(useChatStore.getState().messages[0].timestamp).toBe(42);
  });
});
