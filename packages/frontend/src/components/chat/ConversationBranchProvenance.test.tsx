// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationBranchProvenance } from './ConversationBranchProvenance';

const session: any = { id: 'child', parentSessionId: 'parent', sourceMessageId: 'source-message', label: 'conversation_branch' };

describe('ConversationBranchProvenance', () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it('opens the exact source message anchor when available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessionId: 'parent', sessionKey: 'parent01', sessionName: '원본 대화', messageShortId: 'msg00001', hash: '#m-msg00001' }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const navigation = vi.fn(); window.addEventListener('kanban-select-session', navigation);
    render(<ConversationBranchProvenance session={session} />);
    const button = await screen.findByRole('button', { name: /원본 대화의 과거 메시지에서 시작됨/ });
    fireEvent.click(button);
    await waitFor(() => expect(navigation).toHaveBeenCalled());
    expect((navigation.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 'parent', sessionKey: 'parent01', hash: '#m-msg00001' });
    window.removeEventListener('kanban-select-session', navigation);
  });
});
