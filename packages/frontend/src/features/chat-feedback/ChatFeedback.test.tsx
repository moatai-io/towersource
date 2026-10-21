// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatFeedback } from './ChatFeedback';
import { reportChatRequestFailure, setChatConnection, useChatFeedback } from './feedback';
import { useChatStore } from '../../stores/chat-store';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
beforeEach(() => {
  vi.useFakeTimers();
  useChatFeedback.setState({ connected: true, requests: {} });
  useChatStore.setState({ turnStateBySession: {} });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('delays disconnect status and removes it on reconnect without changing runs', () => {
  render(<ChatFeedback sessionId="a" />);
  act(() => setChatConnection(false));
  expect(screen.queryByRole('status')).toBeNull();
  act(() => vi.advanceTimersByTime(1500));
  expect(screen.getByRole('status').textContent).toContain('chatFeedback.reconnecting');
  act(() => reportChatRequestFailure('a'));
  expect(useChatFeedback.getState().requests).toEqual({});
  act(() => setChatConnection(true));
  expect(screen.queryByRole('status')).toBeNull();
  expect(useChatStore.getState().turnStateBySession).toEqual({});
});
it('keeps request feedback session-local and expires it', () => {
  reportChatRequestFailure('a');
  const view = render(<ChatFeedback sessionId="b" />);
  expect(screen.queryByRole('status')).toBeNull();
  view.rerender(<ChatFeedback sessionId="a" />);
  expect(screen.getByRole('status').textContent).toContain('chatFeedback.requestFailed');
  act(() => vi.advanceTimersByTime(8000));
  expect(screen.queryByRole('status')).toBeNull();
});
it('shows confirmed run errors until a new run replaces them', () => {
  useChatStore.setState({ turnStateBySession: { a: { phase: 'error', startedAt: null, lastActivityAt: null, pendingMessageCount: 0, errorMessage: 'safe failure' } } });
  render(<ChatFeedback sessionId="a" />);
  expect(screen.getByRole('status').textContent).toContain('safe failure');
  act(() => vi.advanceTimersByTime(10000));
  expect(screen.getByRole('status')).toBeTruthy();
  act(() => useChatStore.setState({ turnStateBySession: {} }));
  expect(screen.queryByRole('status')).toBeNull();
});
it('does not flash during a brief reconnect and has no unowned request notice', () => {
  reportChatRequestFailure(null);
  expect(useChatFeedback.getState().requests).toEqual({});
  render(<ChatFeedback sessionId="a" />);
  act(() => setChatConnection(false));
  act(() => vi.advanceTimersByTime(500));
  act(() => setChatConnection(true));
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.queryByRole('status')).toBeNull();
});
it('removes stale request feedback when a new turn starts', () => {
  reportChatRequestFailure('a');
  render(<ChatFeedback sessionId="a" />);
  act(() => useChatStore.setState({ turnStateBySession: { a: { phase: 'preparing', startedAt: 1, lastActivityAt: 1, pendingMessageCount: 0 } } }));
  expect(screen.queryByRole('status')).toBeNull();
});
