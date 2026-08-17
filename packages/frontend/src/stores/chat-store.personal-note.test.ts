// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from './chat-store';

describe('chat-store personal_note_append dispatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useChatStore.setState({
      messages: [{
        id: 'assistant-1',
        role: 'assistant',
        timestamp: Date.now(),
        content: [{
          type: 'tool_use',
          toolUse: { id: 'tool-personal-1', name: 'personal_note_append', input: { text: '계약서 검토', checklist: true } },
        }],
      }],
    } as never);
  });

  it('opens the returned personal inbox URI in Viewer after a successful append', () => {
    const listener = vi.fn();
    window.addEventListener('tower-open-path', listener);

    useChatStore.getState().attachToolResult('tool-personal-1', JSON.stringify({
      ok: true,
      action: 'personal_note_append',
      uri: 'personal://notes/inbox.md',
      focus: true,
      split: 'right',
    }));
    vi.runAllTimers();

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      path: 'personal://notes/inbox.md',
      split: 'right',
    });
    window.removeEventListener('tower-open-path', listener);
    vi.useRealTimers();
  });
});
