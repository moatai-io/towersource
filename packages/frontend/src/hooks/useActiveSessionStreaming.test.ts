// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useActiveSessionStreaming } from './useActiveSessionStreaming';
import { useChatStore } from '../stores/chat-store';
import { useSessionStore } from '../stores/session-store';

beforeEach(() => {
  useChatStore.setState({
    sessionId: null,
    isStreaming: false,
    turnStateBySession: {},
  });
  useSessionStore.setState({
    activeSessionId: null,
    streamingSessions: new Set(),
  });
});

describe('useActiveSessionStreaming', () => {
  it('does not treat awaiting_user as active streaming even if session-store is still marked streaming', () => {
    useChatStore.setState({
      sessionId: 's1',
      turnStateBySession: {
        s1: {
          phase: 'awaiting_user',
          startedAt: Date.now(),
          lastActivityAt: Date.now(),
          pendingMessageCount: 0,
          pendingQuestionId: 'q-1',
        },
      },
    });
    useSessionStore.setState({
      activeSessionId: 's1',
      streamingSessions: new Set(['s1']),
    });

    const { result } = renderHook(() => useActiveSessionStreaming());

    expect(result.current).toBe(false);
  });
});
