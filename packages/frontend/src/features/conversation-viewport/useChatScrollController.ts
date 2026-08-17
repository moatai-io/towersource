import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { useConversationViewport } from './useConversationViewport';

export type BottomPinSource = 'session' | 'messages-loaded' | 'jump-latest' | 'streaming' | 'compact';
export type HistoryReadSource = 'scroll' | 'jump';

export type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

type UseChatScrollControllerArgs = {
  activeSessionId: string | null;
  /** Raw visible message count used by the viewport state machine. */
  viewportMessageCount: number;
  /** Rendered/merged list count used by ChatPanel jump targets. */
  listMessageCount: number;
  scrollWrapRef: MutableRefObject<HTMLDivElement | null>;
  isAtBottomRef: MutableRefObject<boolean>;
  userScrolledUpRef: MutableRefObject<boolean>;
  setShowJumpToLatest: Dispatch<SetStateAction<boolean>>;
};

/**
 * Owns chat scroll intent transitions shared by ChatPanel's plain and virtualized lists.
 * DOM/Virtuoso movement still lives in ChatPanel; this hook centralizes the policy state.
 */
export function useChatScrollController({
  activeSessionId,
  viewportMessageCount,
  listMessageCount,
  scrollWrapRef,
  isAtBottomRef,
  userScrolledUpRef,
  setShowJumpToLatest,
}: UseChatScrollControllerArgs) {
  const conversationViewport = useConversationViewport({
    activeSessionId,
    messageCount: viewportMessageCount,
  });

  const getCurrentScrollerMetrics = useCallback((): ScrollMetrics | null => {
    const scroller = scrollWrapRef.current?.querySelector('[data-testid="virtuoso-scroller"]') as HTMLElement | null;
    if (!scroller) return null;
    return {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
    };
  }, [scrollWrapRef]);

  const markPinnedToBottom = useCallback((source: BottomPinSource = 'jump-latest') => {
    userScrolledUpRef.current = false;
    isAtBottomRef.current = true;
    setShowJumpToLatest(false);
    const now = Date.now();
    if (source === 'session') {
      conversationViewport.dispatch({ type: 'session-changed', sessionId: activeSessionId, messageCount: listMessageCount, nowMs: now });
    } else if (source === 'messages-loaded') {
      conversationViewport.dispatch({ type: 'messages-loaded', messageCount: listMessageCount, nowMs: now });
    } else if (source === 'streaming') {
      conversationViewport.onStreamingStarted(now);
    } else if (source === 'compact') {
      conversationViewport.onCompactFinished(now);
    } else {
      conversationViewport.onJumpToLatest(listMessageCount, now);
    }
    return now;
  }, [activeSessionId, listMessageCount, conversationViewport.dispatch, conversationViewport.onStreamingStarted, conversationViewport.onCompactFinished, conversationViewport.onJumpToLatest, isAtBottomRef, userScrolledUpRef, setShowJumpToLatest]);

  const markUserReadingHistory = useCallback((source: HistoryReadSource = 'scroll') => {
    if (!userScrolledUpRef.current) {
      userScrolledUpRef.current = true;
    }
    setShowJumpToLatest(true);
    if (source === 'jump') conversationViewport.onJumpToHistory();
    else conversationViewport.onUserScrollUp();
  }, [conversationViewport.onJumpToHistory, conversationViewport.onUserScrollUp, userScrolledUpRef, setShowJumpToLatest]);

  return {
    conversationViewport,
    getCurrentScrollerMetrics,
    markPinnedToBottom,
    markUserReadingHistory,
  };
}
