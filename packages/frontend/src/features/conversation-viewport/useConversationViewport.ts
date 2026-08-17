/**
 * Owns: React adapter around the pure conversation viewport state machine.
 * Public API: useConversationViewport.
 * See README.md.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createScrollIntentState,
  reduceScrollIntent,
  shouldAutoFollowOutput,
  type ScrollIntentEvent,
} from './scrollIntentMachine';
import type { ScrollIntentPolicy, ScrollIntentState, ViewportMetrics } from './viewportTypes';

type UseConversationViewportOptions = {
  activeSessionId: string | null;
  messageCount: number;
  policy?: ScrollIntentPolicy;
};

/**
 * Keep conversation scroll ownership in one inspectable state object.
 *
 * The hook intentionally does not write scrollTop or call Virtuoso. It only
 * answers “is auto-follow allowed?” and records the latest user/app intent.
 */
export function useConversationViewport({ activeSessionId, messageCount, policy }: UseConversationViewportOptions) {
  const [state, setState] = useState<ScrollIntentState>(() => createScrollIntentState({ activeSessionId, messageCount }));
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const dispatch = useCallback((event: ScrollIntentEvent) => {
    setState((current) => reduceScrollIntent(current, event, policy));
  }, [policy]);

  useEffect(() => {
    dispatch({ type: 'session-changed', sessionId: activeSessionId, messageCount, nowMs: Date.now() });
  }, [activeSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    dispatch({ type: 'content-changed', messageCount, nowMs: Date.now() });
  }, [messageCount, dispatch]);

  const shouldAutoFollow = useCallback((nowMs = Date.now()) => {
    return shouldAutoFollowOutput(state, nowMs);
  }, [state]);

  const onUserScroll = useCallback((metrics: ViewportMetrics, nowMs = Date.now()) => {
    dispatch({ type: 'user-scroll', metrics, nowMs });
  }, [dispatch]);

  const onUserScrollUp = useCallback((nowMs = Date.now()) => {
    dispatch({ type: 'user-scroll-up', nowMs });
  }, [dispatch]);

  const onJumpToLatest = useCallback((nextMessageCount = messageCount, nowMs = Date.now()) => {
    dispatch({ type: 'jump-to-latest', messageCount: nextMessageCount, nowMs });
  }, [dispatch, messageCount]);

  const onJumpToHistory = useCallback((nowMs = Date.now()) => {
    dispatch({ type: 'jump-to-history', nowMs });
  }, [dispatch]);

  const onRestoreAnchorStart = useCallback((nowMs = Date.now()) => {
    dispatch({ type: 'restore-anchor-start', nowMs });
  }, [dispatch]);

  const onRestoreAnchorEnd = useCallback((metrics: ViewportMetrics, nowMs = Date.now()) => {
    dispatch({ type: 'restore-anchor-end', metrics, nowMs });
  }, [dispatch]);

  const onStreamingStarted = useCallback((nowMs = Date.now()) => {
    dispatch({ type: 'streaming-started', nowMs });
  }, [dispatch]);

  const onCompactFinished = useCallback((nowMs = Date.now()) => {
    dispatch({ type: 'compact-finished', nowMs });
  }, [dispatch]);

  return useMemo(() => ({
    state,
    stateRef,
    dispatch,
    shouldAutoFollow,
    onUserScroll,
    onUserScrollUp,
    onJumpToLatest,
    onJumpToHistory,
    onRestoreAnchorStart,
    onRestoreAnchorEnd,
    onStreamingStarted,
    onCompactFinished,
  }), [
    state,
    dispatch,
    shouldAutoFollow,
    onUserScroll,
    onUserScrollUp,
    onJumpToLatest,
    onJumpToHistory,
    onRestoreAnchorStart,
    onRestoreAnchorEnd,
    onStreamingStarted,
    onCompactFinished,
  ]);
}
