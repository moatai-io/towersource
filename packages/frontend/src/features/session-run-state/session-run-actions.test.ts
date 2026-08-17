import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../../stores/chat-store';
import { useSessionStore } from '../../stores/session-store';
import { markSessionRunActive, markSessionRunAwaitingUser, markSessionRunFinished, markSessionRunIdle, markSessionRunQueued } from './session-run-actions';

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => 'admin'),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  useSessionStore.setState({
    streamingSessions: new Set(),
    unreadSessions: new Set(),
    sessions: [],
    activeSessionId: null,
    activeView: 'chat',
  } as any);
  useChatStore.setState({
    turnStateBySession: {},
    messageQueue: {},
  } as any);
});

describe('session-run-actions', () => {
  it('preserves authoritative startedAt across generic preparing heartbeats', () => {
    const acceptedAt = Date.now() - 20 * 60_000;
    markSessionRunActive('s1', 'streaming', { startedAt: acceptedAt });
    markSessionRunActive('s1', 'preparing');

    expect(useChatStore.getState().turnStateBySession.s1.startedAt).toBe(acceptedAt);
  });

  it('marks active runs in both sidebar and turn-state planes', () => {
    markSessionRunActive('s1', 'tool_running', { activeToolSummary: 'read docs' });

    expect(useSessionStore.getState().streamingSessions.has('s1')).toBe(true);
    expect(useChatStore.getState().turnStateBySession.s1).toMatchObject({
      phase: 'tool_running',
      activeToolSummary: 'read docs',
    });
  });

  it('finishes only after a local streaming edge when requested', () => {
    markSessionRunFinished('s1', 'done', { pendingMessageCount: 0 }, { onlyIfWasStreaming: true });
    expect(useChatStore.getState().turnStateBySession.s1).toBeUndefined();

    markSessionRunActive('s1', 'streaming');
    markSessionRunFinished('s1', 'done', { pendingMessageCount: 0 }, { onlyIfWasStreaming: true });
    expect(useSessionStore.getState().streamingSessions.has('s1')).toBe(false);
    expect(useChatStore.getState().turnStateBySession.s1).toMatchObject({ phase: 'done' });
  });

  it('clears stale running state without requiring a completion edge', () => {
    markSessionRunActive('s1', 'streaming');
    markSessionRunIdle('s1', { pendingMessageCount: 0 });

    expect(useSessionStore.getState().streamingSessions.has('s1')).toBe(false);
    expect(useChatStore.getState().turnStateBySession.s1).toMatchObject({ phase: 'idle' });
  });

  it('marks awaiting user without a streaming spinner', () => {
    markSessionRunActive('s1', 'streaming');
    markSessionRunAwaitingUser('s1', 'q1');

    expect(useSessionStore.getState().streamingSessions.has('s1')).toBe(false);
    expect(useChatStore.getState().turnStateBySession.s1).toMatchObject({
      phase: 'awaiting_user',
      pendingQuestionId: 'q1',
    });
  });

  it('marks queued as a running sidebar state', () => {
    markSessionRunQueued('s1', 3);

    expect(useSessionStore.getState().streamingSessions.has('s1')).toBe(true);
    expect(useChatStore.getState().turnStateBySession.s1).toMatchObject({
      phase: 'queued',
      pendingMessageCount: 3,
    });
  });
});
