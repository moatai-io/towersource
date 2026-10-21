// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../stores/chat-store';
import { useFileStore } from '../stores/file-store';
import { useChatRuntime } from './useChatRuntime';

vi.mock('./useWebSocket', () => ({
  useWebSocket: () => ({ send: vi.fn(), connected: false, ws: { current: null }, safetyTimerFired: false }),
}));

describe('chat runtime render isolation', () => {
  it('does not rerender its host for streamed chat or file store updates', () => {
    let renders = 0;
    const { unmount } = renderHook(() => {
      renders++;
      return useChatRuntime(false);
    });
    const initial = renders;
    act(() => {
      useChatStore.getState().setMessages([{ id: 'stream-render-test', role: 'assistant', content: [{ type: 'text', text: 'delta' }], timestamp: 1 }]);
      useChatStore.getState().setStreaming(true);
      useFileStore.getState().setTree([]);
    });
    expect(renders).toBe(initial);
    unmount();
    useChatStore.getState().setStreaming(false);
    useChatStore.getState().setMessages([]);
  });
});
