// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from './chat-store';

describe('chat-store present_file dispatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useChatStore.setState({
      sessionId: 's1',
      messages: [{
        id: 'a1',
        role: 'assistant',
        content: [{
          type: 'tool_use',
          toolUse: {
            id: 'tool-present-1',
            name: 'present_file',
            input: { path: '/workspace/report.md' },
          },
        }],
      } as any],
    });
  });

  it('does not duplicate live present_file delivery from the session-scoped tool result', () => {
    const listener = vi.fn();
    window.addEventListener('tower-present-file', listener as EventListener);

    useChatStore.getState().attachToolResult('tool-present-1', JSON.stringify({
      ok: true,
      action: 'present_file',
      path: '/workspace/report.md',
      split: 'bottom',
    }));

    vi.runOnlyPendingTimers();

    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener('tower-present-file', listener as EventListener);
  });

  it('replays the latest completed present_file when messages are loaded on session return', () => {
    const listener = vi.fn();
    window.addEventListener('tower-present-file', listener as EventListener);

    useChatStore.getState().setMessages([{
      id: 'a1',
      role: 'assistant',
      timestamp: Date.now(),
      content: [{
        type: 'tool_use',
        toolUse: {
          id: 'tool-present-1',
          name: 'present_file',
          input: { path: '/workspace/report.md' },
          result: JSON.stringify({ ok: true, path: '/workspace/report.md', split: 'right' }),
        },
      }],
    }], { replayPresentFile: true });

    vi.runOnlyPendingTimers();

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      path: '/workspace/report.md',
      split: 'right',
      sessionId: 's1',
      deliveryId: 'tool-present-1',
      focus: true,
      label: undefined,
    });

    window.removeEventListener('tower-present-file', listener as EventListener);
  });

  it('replays stored tool_result blocks paired with present_file tool_use blocks', () => {
    const listener = vi.fn();
    window.addEventListener('tower-present-file', listener as EventListener);

    useChatStore.getState().setMessages([{
      id: 'a1',
      role: 'assistant',
      timestamp: Date.now(),
      content: [
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-present-1',
            name: 'present_file',
            input: { path: '/workspace/report.md' },
          },
        },
        {
          type: 'tool_result',
          toolUse: {
            id: 'tool-present-1',
            name: '',
            input: {},
            result: JSON.stringify({ ok: true, path: '/workspace/report.md', split: 'right' }),
          },
        },
      ],
    }], { replayPresentFile: true });

    vi.runOnlyPendingTimers();

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      path: '/workspace/report.md',
      split: 'right',
      sessionId: 's1',
      deliveryId: 'tool-present-1',
      focus: true,
      label: undefined,
    });

    window.removeEventListener('tower-present-file', listener as EventListener);
  });

  it('replays focus=false as a quiet Viewer tab intent', () => {
    const listener = vi.fn();
    window.addEventListener('tower-present-file', listener as EventListener);

    useChatStore.getState().setMessages([{
      id: 'a1',
      role: 'assistant',
      timestamp: Date.now(),
      content: [{
        type: 'tool_use',
        toolUse: {
          id: 'tool-present-1',
          name: 'present_file',
          input: { path: '/workspace/report.md' },
          result: JSON.stringify({ ok: true, path: '/workspace/report.md', focus: false }),
        },
      }],
    }], { replayPresentFile: true });

    vi.runOnlyPendingTimers();

    expect((listener.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
      path: '/workspace/report.md',
      sessionId: 's1',
      focus: false,
    });
    window.removeEventListener('tower-present-file', listener as EventListener);
  });
});
