// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import i18n from '../../i18n';
import { AgentCard, AgentOriginBubble } from './AgentCards';
import { useSessionStore } from '../../stores/session-store';
import { useChatStore, type ChatMessage, type ContentBlock } from '../../stores/chat-store';

const sender = '11111111-1111-4111-8111-111111111111';
const recipient = '22222222-2222-4222-8222-222222222222';
const block = (name = 'persistent_agent_send', input: Record<string, string> = { worker: 'worker-id', message: '검토해 주세요' }, result = `- backingSessionId: ${recipient}\n- agentName: 보안 리뷰`): ContentBlock => ({
  type: 'tool_use', toolUse: { id: `communication-${name}`, name, input, result },
});

beforeEach(async () => {
  cleanup();
  await i18n.changeLanguage('ko');
  useChatStore.setState({ sessionId: sender, messages: [], turnStateBySession: {} });
  useSessionStore.setState({ sessions: [
    { id: sender, name: '구현 검토' }, { id: recipient, name: '보안 리뷰' },
  ] as any, streamingSessions: new Set() });
});

describe('agent communication routes', () => {
  it('shows both session names and links while collapsed; navigation does not expand the card', () => {
    render(<AgentCard block={block()} />);
    const from = screen.getByRole('link', { name: /구현 검토/ });
    const to = screen.getByRole('link', { name: /보안 리뷰/ });
    expect(from).toHaveAttribute('href', `/s/${sender}`);
    expect(to).toHaveAttribute('href', `/s/${recipient}`);
    expect(to.closest('button')).toBeNull();
    let detail: unknown;
    const listener = (e: Event) => { detail = (e as CustomEvent).detail; };
    window.addEventListener('kanban-select-session', listener);
    fireEvent.click(to);
    window.removeEventListener('kanban-select-session', listener);
    expect(detail).toEqual({ sessionId: recipient, forceNew: false });
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('link', { name: /보안 리뷰/ }).closest('button')).toBeNull();
  });

  it('resolves legacy sends by their session input and keeps unknown targets unlinked', () => {
    render(<AgentCard block={block('send_to_session', { session_id: recipient, message: '질문' }, 'Sent to session 22222222')} />);
    expect(screen.getByRole('link', { name: /보안 리뷰/ })).toBeInTheDocument();
    useSessionStore.setState({ sessions: [{ id: sender, name: '구현 검토' }] as any });
    cleanup();
    render(<AgentCard block={block('persistent_agent_create', { name: '새 검토자' }, '')} />);
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByTitle('받는 세션: 새 검토자')).toBeInTheDocument();
  });

  it('shows the actual peer sender for incoming requests, rather than reversing parent/child', () => {
    useChatStore.setState({ sessionId: recipient });
    const message = { id: 'incoming-peer', role: 'user', content: [{ type: 'text', text: '검토 요청' }], metadata: {
      sourceType: 'agent_send', agentSend: { parentSessionId: sender, parentSessionName: '옛 이름', fromName: '구현 검토' },
    } } as ChatMessage;
    render(<AgentOriginBubble message={message} />);
    const route = screen.getByLabelText('소통 경로');
    expect(route.textContent).toBe('↗구현 검토→↗보안 리뷰');
  });

  it('reverses the direction for a worker response and exposes full names in titles', () => {
    const message = { id: 'worker-response', role: 'user', content: [{ type: 'text', text: '검토 완료' }], metadata: {
      sourceType: 'agent_wake', agentWake: { backingSessionId: recipient, workerName: '보안 리뷰' },
    } } as ChatMessage;
    render(<AgentOriginBubble message={message} />);
    expect(screen.getByLabelText('소통 경로').textContent).toBe('↗보안 리뷰→↗구현 검토');
    expect(screen.getByTitle('보낸 세션: 보안 리뷰')).toHaveAttribute('href', `/s/${recipient}`);
  });
});
