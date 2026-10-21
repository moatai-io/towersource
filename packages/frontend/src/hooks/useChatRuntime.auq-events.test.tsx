// @vitest-environment jsdom
import { act, renderHook, cleanup } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../stores/chat-store';
import { useSessionStore } from '../stores/session-store';
import { useChatRuntime } from './useChatRuntime';
import { deriveSessionRowActivity, deriveSessionRowState } from '../features/session-run-state/session-row-state';

const transport = vi.hoisted(() => ({ receive: (_data: any) => {} }));
vi.mock('./useWebSocket', () => ({
  useWebSocket: (_url: unknown, handler: (data: any) => void) => {
    transport.receive = handler;
    return { send: vi.fn(), connected: false, ws: { current: null }, safetyTimerFired: false };
  },
}));

beforeEach(() => {
  useChatStore.setState({ turnStateBySession: {}, pendingQuestion: null, isStreaming: false, messageQueue: {} });
  useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set(), unreadSessions: new Set() });
  renderHook(() => useChatRuntime(false));
});
afterEach(cleanup);
const event = (data: any) => act(() => transport.receive({ sessionId: 's1', ...data }));
const ask = (questionId: string) => event({ type: 'ask_user', questionId, questions: [{ question: 'Choose', options: ['Yes', 'No'] }] });
const indicator = () => {
  const phase = useChatStore.getState().turnStateBySession.s1?.phase;
  return deriveSessionRowState(deriveSessionRowActivity({ phase, isStreaming: useSessionStore.getState().streamingSessions.has('s1'), queueCount: 0 }), false).indicator.kind;
};

describe('AUQ websocket event ordering', () => {
  it.each(['answer_question_ack', 'ask_user_timeout', 'session_awaiting_user'])('ignores stale %s without erasing a newer popup or list indicator', (type) => {
    ask('old');
    ask('new');
    event({ type, questionId: 'old', awaiting: false });
    expect(indicator()).toBe('awaiting_user');
    expect(useChatStore.getState().pendingQuestion?.questionId).toBe('new');
    expect(useChatStore.getState().isStreaming).toBe(false);
    event({ type, questionId: 'new', awaiting: false });
    expect(indicator()).toBe('running');
    expect(useChatStore.getState().pendingQuestion).toBeNull();
  });

  it('handles clear then ACK idempotently and ignores missing question IDs', () => {
    ask('q1');
    event({ type: 'ask_user_timeout' });
    expect(indicator()).toBe('awaiting_user');
    event({ type: 'session_awaiting_user', questionId: 'q1', awaiting: false });
    event({ type: 'answer_question_ack', questionId: 'q1' });
    expect(useChatStore.getState().isStreaming).toBe(true);
    expect(useChatStore.getState().pendingQuestion).toBeNull();
    expect(indicator()).toBe('running');
  });

  it('restores unanswered list attention on reconnect without opening a popup', () => {
    event({ type: 'connected', pendingQuestions: [{ sessionId: 's1', questionId: 'restored' }] });
    expect(indicator()).toBe('awaiting_user');
    expect(useChatStore.getState().pendingQuestion).toBeNull();
    event({ type: 'session_status', status: 'idle' });
    expect(indicator()).toBe('awaiting_user');
  });

  it('preserves list attention when session selection clears the foreground transcript', () => {
    ask('waiting');
    act(() => {
      // Same foreground reset sequence used by useSessionSelection.
      useChatStore.getState().setStreaming(false);
      useChatStore.getState().clearMessages();
      useSessionStore.setState({ activeSessionId: 's2' });
      useChatStore.getState().setSessionId('s2');
    });
    expect(useChatStore.getState().pendingQuestion).toBeNull();
    expect(indicator()).toBe('awaiting_user');
    expect(useChatStore.getState().turnStateBySession.s1.pendingQuestionId).toBe('waiting');
    event({ type: 'session_status', status: 'idle' });
    expect(indicator()).toBe('awaiting_user');
    event({ type: 'answer_question_ack', questionId: 'waiting' });
    expect(indicator()).toBe('running');
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('does not start the foreground spinner for a background answer', () => {
    event({ type: 'session_awaiting_user', sessionId: 'background', questionId: 'q1', awaiting: true });
    event({ type: 'answer_question_ack', sessionId: 'background', questionId: 'q1' });
    expect(useChatStore.getState().isStreaming).toBe(false);
  });
});
