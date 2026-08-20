// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationBranchProvenance } from './ConversationBranchProvenance';
import '../../i18n';
import i18n from '../../i18n';

const session: any = { id: 'child', parentSessionId: 'parent', sourceMessageId: 'source-message', label: 'conversation_branch' };

describe('ConversationBranchProvenance', () => {
  beforeEach(async () => { localStorage.clear(); vi.restoreAllMocks(); await i18n.changeLanguage('en'); });

  it('opens the exact source message anchor when available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessionId: 'parent', sessionKey: 'parent01', sessionName: '원본 대화', messageShortId: 'msg00001', hash: '#m-msg00001' }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const navigation = vi.fn(); window.addEventListener('kanban-select-session', navigation);
    render(<ConversationBranchProvenance session={session} />);
    const button = await screen.findByRole('button', { name: /Started from an earlier message in 원본 대화/ });
    fireEvent.click(button);
    await waitFor(() => expect(navigation).toHaveBeenCalled());
    expect((navigation.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 'parent', sessionKey: 'parent01', hash: '#m-msg00001' });
    window.removeEventListener('kanban-select-session', navigation);
  });
});
