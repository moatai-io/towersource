// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from './chat-store';

describe('personal_note_append Viewer dispatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useChatStore.getState().clearMessages();
  });

  it('opens the returned personal URI after a successful append', () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    useChatStore.getState().addMessage({
      id: 'assistant-personal-note',
      role: 'assistant',
      timestamp: Date.now(),
      content: [{
        type: 'tool_use',
        toolUse: { id: 'tool-personal-note', name: 'personal_note_append', input: { text: '계약서 검토', checklist: true }, result: '' },
      }],
    });

    useChatStore.getState().attachToolResult('tool-personal-note', JSON.stringify({
      ok: true,
      action: 'personal_todo_add',
      uri: 'personal://todos',
      focus: true,
      split: 'right',
    }));
    vi.runAllTimers();

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tower-open-path',
      detail: { path: 'personal://todos', split: 'right' },
    }));
  });
});
