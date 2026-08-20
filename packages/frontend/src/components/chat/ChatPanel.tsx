import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useChatStore, type ChatMessage, type ContentBlock, type PendingQuestion, type TurnPhase } from '../../stores/chat-store';
import { useSessionStore } from '../../stores/session-store';
import { useFileStore } from '../../stores/file-store';
import { useAiPanelStore } from '../../stores/ai-panel-store';
import { useSessionAwareModel } from '../../stores/model-store';
import { normalizeContentBlocks } from '../../utils/message-parser';
import { MessageBubble, TurnMetricsBar } from './MessageBubble';
import { InputBox, type SendOptions } from './InputBox';
import { FloatingQuestionCard } from './FloatingQuestionCard';
import { ConversationBranchProvenance } from './ConversationBranchProvenance';
import { useActiveSessionTurnState } from '../../hooks/useActiveSessionTurnState';
import {
  getVisibleChatMessages,
  isAgentOriginMessage,
  mergeConsecutiveAssistant,
} from '../../features/agent-card/agent-message-policy';
import { hasSeenTowerGuide, markTowerGuideSeen, TOUR_STATE_CHANGED_EVENT } from '../../tours/tourState';
import { traceChatScroll } from '../../features/conversation-viewport/scrollDebugTrace';
import { logClientPerf, perfNow } from '../../utils/client-perf';
import { serverNowMs } from '../../utils/server-clock';
import { useChatScrollController } from '../../features/conversation-viewport/useChatScrollController';
import { useProjectStore } from '../../stores/project-store';
import { useSettingsStore } from '../../stores/settings-store';
import { isPureAgentSession } from '../../features/agent-sessions/classification';
import { AgentIdentityAvatar } from '../../features/agent-profile/AgentIdentityAvatar';
import {
  CHAT_VIEWPORT_PROJECTION_VERSION,
  captureSessionViewportSnapshot,
  chooseSessionViewportRestorePlan,
  getSessionViewportSnapshot,
  type ChatViewportSnapshot,
  type SessionViewportRestorePlan,
} from '../../features/conversation-viewport/sessionViewportSnapshot';

const USER_JUMP_SCROLL_DURATION_MS = 100;
// Keep the plain DOM path only for genuinely small chats. Past this, full
// message DOM + markdown/visual blocks can make Chrome janky during streaming.
const PLAIN_MESSAGE_LIMIT = 40;
// Keep streaming auto-follow responsive; this mostly affects scroll smoothness,
// not memory. Higher values can feel clumsy during long assistant messages.
const STREAM_AUTOSCROLL_INTERVAL_MS = 100;
// When a user deliberately scrolls upward during streaming, Virtuoso can emit
// an immediate atBottom=true callback before the browser has visibly moved the
// viewport. Keep bottom re-arming disabled for a short gesture window so the
// live output cannot tug the reader back down.
const USER_SCROLL_UP_REARM_GRACE_MS = 700;
const VIRTUOSO_VIEWPORT_OVERHANG = {
  // Upward reading is the expensive path: if too little content is mounted
  // above the viewport, fast desktop wheel/trackpad scrolls expose blank rows
  // while Virtuoso catches up. Keep a larger top buffer for smoother reading.
  top: 5000,
  bottom: 1600,
};
// Chat rows can finish measuring after the first restore pass (Markdown/code
// blocks, tool cards, images, fonts). Keep the selected message anchored for a
// short settle window so late height changes above it do not make revisits drift
// upward again.
const RESTORE_ANCHOR_SETTLE_MAX_MS = 2400;
const RESTORE_ANCHOR_STABLE_FRAMES = 4;
const NORMALIZE_CACHE_MAX_ENTRIES = 700;

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Native smooth scrolling does not expose duration and feels too slow for
 * Option/Alt + ↑/↓ user-message navigation. This keeps the spatial cue but
 * caps the animation to ~0.1s.
 */
function fastScrollElementIntoView(scroller: HTMLElement, target: HTMLElement, durationMs = USER_JUMP_SCROLL_DURATION_MS) {
  const scrollerRect = scroller.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const from = scroller.scrollTop;
  const to = from + targetRect.top - scrollerRect.top;
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const clampedTo = Math.max(0, Math.min(max, to));
  const delta = clampedTo - from;
  if (Math.abs(delta) < 1) return;

  const start = performance.now();
  const step = (now: number) => {
    const progress = Math.min(1, (now - start) / durationMs);
    scroller.scrollTop = from + delta * easeOutCubic(progress);
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* Do not restore Virtuoso's full StateSnapshot or a raw saved scrollTop.
 * Both approaches were removed after stale heights and message-count drift
 * landed sessions at arbitrary middle positions. Open-tab revisit restoration
 * uses a stable rendered message ID plus its relative viewport offset instead. */

/**
 * Merge consecutive assistant messages into one visual message.
 * Preserves the original SDK block order (text → tool → text → tool).
 */
/**
 * PlainMessageList: renders ALL messages in a simple scrollable div.
 * Used for conversations with ≤PLAIN_MESSAGE_LIMIT messages. Zero virtualization = zero flicker.
 * Automatically scrolls to bottom on mount and when new messages arrive.
 */
function PlainMessageList({
  messages,
  renderMessage,
  headerComponent,
  footerComponent,
  scrollWrapRef,
  isStreaming,
  isAtBottomRef,
  userScrolledUpRef,
  showJumpToLatest,
  onJumpToLatest,
  onStartReached,
  onTopVisibleIndexChange,
  onBottomVisibleIndexChange,
  onScrollSnapshotChange,
  onUserScrollStateChange,
  onViewportScroll,
  restorePlan,
  onViewportSnapshot,
}: {
  messages: ChatMessage[];
  renderMessage: (index: number) => React.ReactNode;
  headerComponent: React.ReactNode;
  footerComponent: React.ReactNode;
  scrollWrapRef: React.RefObject<HTMLDivElement | null>;
  isStreaming: boolean;
  isAtBottomRef: React.MutableRefObject<boolean>;
  userScrolledUpRef: React.MutableRefObject<boolean>;
  showJumpToLatest: boolean;
  onJumpToLatest: () => void;
  onStartReached: () => void;
  onTopVisibleIndexChange?: (index: number) => void;
  onBottomVisibleIndexChange?: (index: number) => void;
  onScrollSnapshotChange?: (snapshot: { scrollTop: number; topVisibleIndex: number; atBottom: boolean }) => void;
  onUserScrollStateChange?: (scrolledUp: boolean) => void;
  onViewportScroll?: (metrics: { scrollTop: number; scrollHeight: number; clientHeight: number }) => void;
  restorePlan: SessionViewportRestorePlan;
  onViewportSnapshot?: (snapshot: Omit<ChatViewportSnapshot, 'capturedAt' | 'projectionVersion'>) => void;
}) {
  const { t } = useTranslation('chat');
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLen = useRef(messages.length);
  const plainTouchStartY = useRef(0);

  // Scroll to bottom helper
  const scrollToEnd = useCallback(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'auto' });
  }, []);

  // On mount, only bottom-owned tabs run the height-settle retry. A history
  // restore is owned by ChatPanel's message-anchor adapter and must not compete
  // with this loop.
  useEffect(() => {
    if (restorePlan.kind === 'anchor') return;
    scrollToEnd();
    let frame = 0;
    const retry = () => {
      scrollToEnd();
      frame++;
      if (frame < 10) requestAnimationFrame(retry); // ~160ms of retries
    };
    const raf = requestAnimationFrame(retry);
    return () => cancelAnimationFrame(raf);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // On new messages: scroll to bottom if user is at bottom
  useEffect(() => {
    if (messages.length > prevLen.current && !userScrolledUpRef.current) {
      requestAnimationFrame(scrollToEnd);
    }
    prevLen.current = messages.length;
  }, [messages.length, scrollToEnd, userScrolledUpRef]);

  // During streaming: keep at bottom
  useEffect(() => {
    if (!isStreaming || userScrolledUpRef.current) return;
    const id = setInterval(() => {
      if (!userScrolledUpRef.current) scrollToEnd();
    }, STREAM_AUTOSCROLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [isStreaming, scrollToEnd, userScrolledUpRef]);

  const markPlainHistoryReadingIntent = useCallback(() => {
    if (userScrolledUpRef.current) return;
    userScrolledUpRef.current = true;
    isAtBottomRef.current = false;
    onUserScrollStateChange?.(true);
  }, [isAtBottomRef, userScrolledUpRef, onUserScrollStateChange]);

  // rAF throttle for top-visible-index recompute (querySelectorAll across all messages)
  const rafTopRef = useRef(0);
  const latestTopVisibleIndexRef = useRef(0);

  // Scroll event: detect scroll-up + trigger loadMore at top + recompute top visible
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const metrics = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    onViewportScroll?.(metrics);
    isAtBottomRef.current = atBottom;
    if (!atBottom && !userScrolledUpRef.current) {
      userScrolledUpRef.current = true;   // user scrolled up — stop auto-scroll
      onUserScrollStateChange?.(true);
    }
    if (atBottom && userScrolledUpRef.current && !isStreaming) {
      userScrolledUpRef.current = false;
      onUserScrollStateChange?.(false);
    }
    // Trigger loadMore when near top
    if (el.scrollTop < 200) {
      onStartReached();
    }
    // Recompute top/bottom-visible message indices for the nav bar (rAF throttled).
    // Cheap because message count is ≤PLAIN_MESSAGE_LIMIT in this code path.
    if ((onTopVisibleIndexChange || onBottomVisibleIndexChange) && !rafTopRef.current) {
      rafTopRef.current = requestAnimationFrame(() => {
        rafTopRef.current = 0;
        const scroller = scrollRef.current;
        if (!scroller) return;
        const rect = scroller.getBoundingClientRect();
        const wrapTop = rect.top;
        const wrapBottom = rect.bottom;
        const items = scroller.querySelectorAll('[data-msg-index]');
        let firstVisible = -1;
        let lastVisible = -1;
        for (let i = 0; i < items.length; i++) {
          const node = items[i] as HTMLElement;
          const r = node.getBoundingClientRect();
          // Visible if any part overlaps the viewport (with a small fudge).
          if (r.bottom > wrapTop + 8 && r.top < wrapBottom - 8) {
            const idx = parseInt(node.dataset.msgIndex || '0', 10);
            if (firstVisible < 0) firstVisible = idx;
            lastVisible = idx;
          }
        }
        if (firstVisible >= 0) {
          if (latestTopVisibleIndexRef.current !== firstVisible) {
            latestTopVisibleIndexRef.current = firstVisible;
            onTopVisibleIndexChange?.(firstVisible);
          }
          const anchorNode = Array.from(items).find((item) => parseInt((item as HTMLElement).dataset.msgIndex || '-1', 10) === firstVisible) as HTMLElement | undefined;
          onScrollSnapshotChange?.({ scrollTop: scroller.scrollTop, topVisibleIndex: firstVisible, atBottom });
          onViewportSnapshot?.({
            anchorMessageId: messages[firstVisible]?.id ?? null,
            anchorOffsetPx: anchorNode ? anchorNode.getBoundingClientRect().top - wrapTop : 0,
            atBottom,
            renderer: 'plain',
            messageCountAtCapture: messages.length,
          });
        }
        if (lastVisible >= 0) onBottomVisibleIndexChange?.(lastVisible);
      });
    }
  }, [isAtBottomRef, userScrolledUpRef, onStartReached, onTopVisibleIndexChange, onBottomVisibleIndexChange, onScrollSnapshotChange, onUserScrollStateChange, onViewportScroll, onViewportSnapshot, messages, isStreaming]);

  // After mount + scroll-to-end settles, push initial visible indices so the
  // nav bar renders immediately (without waiting for the first scroll).
  useEffect(() => {
    if (!onTopVisibleIndexChange && !onBottomVisibleIndexChange) return;
    const id = setTimeout(() => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      const wrapTop = rect.top;
      const wrapBottom = rect.bottom;
      const items = scroller.querySelectorAll('[data-msg-index]');
      let firstVisible = -1;
      let lastVisible = -1;
      for (let i = 0; i < items.length; i++) {
        const node = items[i] as HTMLElement;
        const r = node.getBoundingClientRect();
        if (r.bottom > wrapTop + 8 && r.top < wrapBottom - 8) {
          const idx = parseInt(node.dataset.msgIndex || '0', 10);
          if (firstVisible < 0) firstVisible = idx;
          lastVisible = idx;
        }
      }
      if (firstVisible >= 0 && latestTopVisibleIndexRef.current !== firstVisible) {
        latestTopVisibleIndexRef.current = firstVisible;
        onTopVisibleIndexChange?.(firstVisible);
      }
      if (lastVisible >= 0) onBottomVisibleIndexChange?.(lastVisible);
    }, 250);
    return () => clearTimeout(id);
  }, [onTopVisibleIndexChange, onBottomVisibleIndexChange]);

  return (
    <div ref={scrollWrapRef} className="flex-1 min-h-0 relative">
      <div
        ref={scrollRef}
        data-chat-scroll="plain"
        className="h-full overflow-y-auto"
        style={{ overscrollBehavior: 'contain' }}
        onScroll={handleScroll}
        onWheel={(event) => {
          if (isStreaming && event.deltaY < 0) markPlainHistoryReadingIntent();
        }}
        onTouchStart={(event) => {
          plainTouchStartY.current = event.touches[0]?.clientY ?? 0;
        }}
        onTouchMove={(event) => {
          const y = event.touches[0]?.clientY ?? 0;
          if (isStreaming && y - plainTouchStartY.current > 24) markPlainHistoryReadingIntent();
        }}
      >
        {/* Spacer pushes content to bottom when messages don't fill the view */}
        <div className="min-h-full flex flex-col justify-end">
          {headerComponent}
          {messages.map((_, i) => (
            <div key={messages[i].id} data-msg-index={i} data-msg-id={messages[i].id}>{renderMessage(i)}</div>
          ))}
          {footerComponent}
        </div>
      </div>
      {showJumpToLatest && (
        <button
          onClick={() => {
            // PlainMessageList path uses its own internal scrollRef — parent's
            // scrollToBottom() only knows the Virtuoso ref, so we must scroll
            // locally here. onJumpToLatest() still runs to reset parent state
            // (userScrolledUp=false, showJumpToLatest=false).
            scrollToEnd();
            onJumpToLatest();
          }}
          className="absolute bottom-4 right-4 z-20 w-8 h-8 flex items-center justify-center rounded-full bg-primary-600 hover:bg-primary-500 text-white shadow-lg border border-primary-400/40 transition-colors"
          title={t('jumpToLatest')}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        </button>
      )}
    </div>
  );
}

interface ChatPanelProps {
  onSend: (message: string, options?: SendOptions) => void;
  onAbort: () => void;
  onSafeStop?: () => void;
  onFileClick?: (path: string) => void;
  onAnswerQuestion?: (questionId: string, answer: string) => void;
  onLoadMore?: (sessionId: string) => Promise<void>;
}

export function ChatPanel({ onSend, onAbort, onSafeStop, onFileClick, onAnswerQuestion, onLoadMore }: ChatPanelProps) {
  const { t, i18n } = useTranslation('chat');
  const messages = useChatStore((s) => s.messages);
  const chatSessionId = useChatStore((s) => s.sessionId);
  const sessionLoading = useChatStore((s) => s.sessionLoading);
  // NOTE: scroll logic needs chat-store's isStreaming (synced with message arrival).
  // useActiveSessionStreaming (session-store) has timing mismatch that causes scroll drift.
  const isStreaming = useChatStore((s) => s.isStreaming);
  const compactingSessionId = useChatStore((s) => s.compactingSessionId);
  const pendingQuestion = useChatStore((s) => s.pendingQuestion);
  const hasMoreMessages = useChatStore((s) => s.hasMoreMessages);
  const loadingMoreMessages = useChatStore((s) => s.loadingMoreMessages);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeTurnTerminal = useSessionStore((s) => activeSessionId ? s.turnTerminalBySession[activeSessionId] : undefined);
  const updateChatTabScroll = useFileStore((s) => s.updateChatTabScroll);
  const activeTurn = useActiveSessionTurnState();
  const displayTurnPhase: TurnPhase = activeTurn.phase;
  const activeAssistantMessageId = activeTurn.activeAssistantMessageId;
  const isCompacting = compactingSessionId !== null && compactingSessionId === activeSessionId;
  const _sessions = useSessionStore((s) => s.sessions); // keep subscription for sidebar reactivity
  const activeSession = _sessions.find((session) => session.id === activeSessionId) || null;
  const activeProject = useProjectStore((s) => activeSession?.projectId ? s.projects.find((project) => project.id === activeSession.projectId) || null : null);
  // Character identity is safe in both Vite dev and production. The Agent-first
  // flag controls navigation rollout, not whether an already-assigned Project
  // portrait may render inside its own conversation.
  const showAssistantCharacter = !!activeProject && !!activeSession && !isPureAgentSession(activeSession);
  const openActiveProjectHome = useCallback(() => {
    if (!activeProject) return;
    useFileStore.getState().openSystemTab('projectFiles', { refId: activeProject.id, title: `${activeProject.agent?.displayName || activeProject.name} 홈`, icon: activeProject.agent?.face || '✨' });
    useSessionStore.getState().setActiveView('chat');
  }, [activeProject]);

  // Defensive render boundary for session switches.
  // App.tsx clears old messages before publishing a new session id, but Zustand
  // external-store notifications and React renders can still interleave across
  // activeSessionId/chatStore.sessionId in rare paths (new session, inbox jump,
  // cache hit). Never render the message array unless it belongs to the active
  // session; a short skeleton/empty state is far less alarming than showing the
  // previous session's messages. See GitHub issue #74.
  const sessionMismatch = !!activeSessionId && !!chatSessionId && activeSessionId !== chatSessionId;
  const renderMessages = sessionMismatch ? [] : messages;
  const renderSessionLoading = sessionLoading || sessionMismatch;

  // Reconcile speaker attribution for already-mounted optimistic bubbles.
  // A user can jump into another user's project session; the local bubble may
  // initially carry stale browser-local identity, while the DB/API has the
  // verified message.username. Patch usernames by id without replacing content
  // or scroll state.
  useEffect(() => {
    if (!activeSessionId || sessionMismatch || messages.length === 0) return;
    let cancelled = false;
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    fetch(`/api/sessions/${activeSessionId}/messages?limit=500`, { headers })
      .then((res) => res.ok ? res.json() : null)
      .then((body) => {
        if (cancelled || !body) return;
        const stored = Array.isArray(body) ? body : body.messages;
        if (!Array.isArray(stored)) return;
        const usernames = new Map<string, string>();
        for (const m of stored) {
          if (m?.role === 'user' && typeof m.username === 'string' && m.username.trim()) {
            usernames.set(m.id, m.username.trim());
          }
        }
        if (usernames.size === 0) return;
        useChatStore.setState((s) => {
          if (s.sessionId !== activeSessionId) return s;
          let changed = false;
          const next = s.messages.map((m) => {
            if (m.role !== 'user') return m;
            const username = usernames.get(m.id);
            if (!username || m.username === username) return m;
            changed = true;
            return { ...m, username };
          });
          return changed ? { messages: next } : s;
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeSessionId, sessionMismatch, messages.length]);

  // Auto-resume banner data — set when ws-handler.ts:serverSideResumeInterrupted()
  // injected a hidden trigger after a backend restart. Banner dismisses once the
  // user posts a new (non-hidden) message that postdates the resume timestamp.
  // See: workspace/decisions/2026-05-10-server-resume-prompt-hidden.md
  const lastAutoResumeAt = useSessionStore((s) =>
    activeSessionId ? s.sessions.find((sess) => sess.id === activeSessionId)?.lastAutoResumeAt ?? null : null
  );

  // Consume pending reply from Inbox (already sent over WS by InboxPanel.sendToSession).
  // Render an optimistic bubble so the user sees their text immediately on open;
  // the real message arrives via the server's `user_message` broadcast and is
  // de-duped by id in mergeMessagesFromDb / addMessage.
  // ⚠️ DO NOT call onSend(pending) here — that would send the chat a SECOND time.
  useEffect(() => {
    if (!activeSessionId) return;
    const pending = useSessionStore.getState().pendingReplies[activeSessionId];
    if (!pending) return;
    useSessionStore.getState().clearPendingReply(activeSessionId);

    // Skip optimistic render if a user message with the same body is already in store
    // (covers the case where user_message broadcast or DB merge already populated it).
    const store = useChatStore.getState();
    if (store.sessionId !== activeSessionId) return;

    const already = store.messages.some((m) => {
      if (m.role !== 'user') return false;
      const body = m.content.find((b) => b.type === 'text')?.text?.trim();
      return body === pending.trim();
    });
    if (already) return;

    store.addMessage({
      id: `inbox-pending-${activeSessionId}-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text: pending }],
      timestamp: Date.now(),
      username: localStorage.getItem('username') || undefined,
      sendStatus: 'delivered',
    });
  }, [activeSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollWrapRef = useRef<HTMLDivElement>(null);
  const isAtBottom = useRef(true);
  // User-initiated scroll-up detection: when true, followOutput stops auto-scrolling
  // and the settle period stops re-snapping to bottom. Cleared when user returns
  // to bottom (via the jump button or by scrolling down themselves).
  const userScrolledUp = useRef(false);
  const bottomRearmSuppressedUntil = useRef(0);
  const streamingHistoryReadLock = useRef(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  // Index of the topmost message currently visible — drives the user-message nav bar
  // above the input. Updated by Virtuoso's rangeChanged (large lists) or by
  // PlainMessageList's onTopVisibleIndexChange (small lists).
  const [topVisibleIndex, setTopVisibleIndex] = useState(0);
  // Index of the *bottom*most visible message — used for ↓ "다음 질문" so we
  // skip past user messages already on screen and land on the next one *below*
  // the viewport. Without this, nextUserIndex often points to a user message
  // already visible → clicking ↓ feels like nothing happens.
  const [bottomVisibleIndex, setBottomVisibleIndex] = useState(0);
  const topVisibleItemId = useRef<string | null>(null);

  const saveChatScrollSnapshot = useCallback((snapshot: { scrollTop?: number; topVisibleIndex?: number; atBottom?: boolean }) => {
    if (!activeSessionId) return;
    updateChatTabScroll(activeSessionId, snapshot);
  }, [activeSessionId, updateChatTabScroll]);

  // Virtuoso's rangeChanged reports the rendered/overscanned range, not the
  // truly visible viewport. With mobile overscan (`increaseViewportBy`) that
  // made the ↑/↓ user-message buttons think messages below the screen were
  // already visible, so ↓ became disabled while more conversation remained.
  // Read the actual DOM rects after render and use rangeChanged only as a
  // temporary fallback until the rAF measurement lands.
  const visibleRangeRafRef = useRef(0);
  const mergedMessages = useMemo(() => {
    return mergeConsecutiveAssistant(getVisibleChatMessages(renderMessages));
  }, [renderMessages]);
  const sessionRenderPerfRef = useRef<{ sessionId: string | null; startedAt: number; logged: boolean }>({
    sessionId: activeSessionId,
    startedAt: perfNow(),
    logged: false,
  });
  useEffect(() => {
    sessionRenderPerfRef.current = { sessionId: activeSessionId, startedAt: perfNow(), logged: false };
  }, [activeSessionId]);
  useEffect(() => {
    const state = sessionRenderPerfRef.current;
    if (!activeSessionId || state.sessionId !== activeSessionId || state.logged) return;
    if (renderSessionLoading || renderMessages.length === 0) return;
    state.logged = true;
    logClientPerf('chat-first-messages-render', {
      sessionId: activeSessionId,
      messageCount: renderMessages.length,
      mergedMessageCount: mergedMessages.length,
      elapsedMs: Math.round(perfNow() - state.startedAt),
    }, { thresholdMs: 800 });
  }, [activeSessionId, renderSessionLoading, renderMessages.length, mergedMessages.length]);
  const hasExplicitMessageAnchor = typeof window !== 'undefined' && /^#m-[a-z2-9]{8}$/.test(window.location.hash);
  const sessionRestorePlan = useMemo(() => {
    if (!activeSessionId) return { kind: 'bottom', reason: 'first-open' } as const;
    return chooseSessionViewportRestorePlan({
      snapshot: getSessionViewportSnapshot(activeSessionId),
      messageIds: mergedMessages.map((message) => message.id),
      hasExplicitMessageAnchor,
    });
  }, [activeSessionId, mergedMessages, hasExplicitMessageAnchor]);
  const restoreInProgressRef = useRef(false);
  const restoredSessionRef = useRef<string | null>(null);
  const restoreAttemptRef = useRef(0);

  const captureViewportSnapshot = useCallback((snapshot: Omit<ChatViewportSnapshot, 'capturedAt' | 'projectionVersion'>) => {
    // Child range callbacks can fire before the parent's restore effect. Do not
    // let that transient mount position overwrite the history snapshot that
    // selected this restore plan.
    if (!activeSessionId || restoreInProgressRef.current || (sessionRestorePlan.kind === 'anchor' && restoredSessionRef.current !== activeSessionId)) return;
    captureSessionViewportSnapshot(activeSessionId, {
      ...snapshot,
      capturedAt: Date.now(),
      projectionVersion: CHAT_VIEWPORT_PROJECTION_VERSION,
    });
  }, [activeSessionId, sessionRestorePlan]);

  const captureActiveViewportBeforeSwitch = useCallback(() => {
    if (!activeSessionId || mergedMessages.length === 0) return;
    // This synchronous capture is the final authority for the session being
    // left. A native-scroll/range callback may still have an rAF measurement
    // queued with an older viewport. If it runs after this event it can replace
    // the exact leave-time anchor and make a revisit jump noticeably upward.
    if (visibleRangeRafRef.current) {
      cancelAnimationFrame(visibleRangeRafRef.current);
      visibleRangeRafRef.current = 0;
    }
    const wrap = scrollWrapRef.current;
    const scroller = (wrap?.querySelector('[data-testid="virtuoso-scroller"]') as HTMLElement | null)
      || (wrap?.querySelector('[data-chat-scroll="plain"]') as HTMLElement | null);
    if (!scroller) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const nodes = Array.from(scroller.querySelectorAll('[data-msg-index]')) as HTMLElement[];
    const anchorNode = nodes.find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.bottom > scrollerRect.top + 8 && rect.top < scrollerRect.bottom - 8;
    });
    if (!anchorNode) return;
    const anchorIndex = Number(anchorNode.dataset.msgIndex);
    const anchorMessage = mergedMessages[anchorIndex];
    if (!anchorMessage) return;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    captureSessionViewportSnapshot(activeSessionId, {
      anchorMessageId: anchorMessage.id,
      anchorOffsetPx: anchorNode.getBoundingClientRect().top - scrollerRect.top,
      atBottom,
      capturedAt: Date.now(),
      renderer: mergedMessages.length <= PLAIN_MESSAGE_LIMIT ? 'plain' : 'virtuoso',
      messageCountAtCapture: mergedMessages.length,
      projectionVersion: CHAT_VIEWPORT_PROJECTION_VERSION,
    });
    traceChatScroll('snapshot-before-switch', { activeSessionId, anchorIndex, atBottom });
  }, [activeSessionId, mergedMessages]);

  useEffect(() => {
    window.addEventListener('tower-capture-chat-viewport', captureActiveViewportBeforeSwitch);
    return () => window.removeEventListener('tower-capture-chat-viewport', captureActiveViewportBeforeSwitch);
  }, [captureActiveViewportBeforeSwitch]);

  const updateVisibleRangeFromDom = useCallback((fallback?: { startIndex: number; endIndex: number }) => {
    if (visibleRangeRafRef.current) cancelAnimationFrame(visibleRangeRafRef.current);
    visibleRangeRafRef.current = requestAnimationFrame(() => {
      visibleRangeRafRef.current = 0;
      // Session selection changes synchronously after the leave-time capture,
      // while this measurement is deferred. Never let a callback owned by the
      // previous session write through after the active session has changed.
      if (useSessionStore.getState().activeSessionId !== activeSessionId) return;
      const wrap = scrollWrapRef.current;
      const scroller = (wrap?.querySelector('[data-testid="virtuoso-scroller"]') as HTMLElement | null)
        || (wrap?.querySelector('[data-virtuoso-scroller]') as HTMLElement | null)
        || (wrap?.querySelector('[data-chat-scroll="plain"]') as HTMLElement | null)
        || (wrap?.firstElementChild instanceof HTMLElement ? wrap.firstElementChild : null);
      if (!scroller) {
        if (!fallback) return;
        traceChatScroll('visible-range-dom', { source: 'fallback-no-scroller', startIndex: fallback.startIndex, endIndex: fallback.endIndex });
        topVisibleItemId.current = mergedMessages[fallback.startIndex]?.id ?? null;
        setTopVisibleIndex((current) => current === fallback.startIndex ? current : fallback.startIndex);
        setBottomVisibleIndex((current) => current === fallback.endIndex ? current : fallback.endIndex);
        saveChatScrollSnapshot({ topVisibleIndex: fallback.startIndex, atBottom: isAtBottom.current });
        return;
      }

      const rect = scroller.getBoundingClientRect();
      const wrapTop = rect.top;
      const wrapBottom = rect.bottom;
      const items = scroller.querySelectorAll('[data-msg-index]');
      let firstVisible = -1;
      let lastVisible = -1;
      for (let i = 0; i < items.length; i++) {
        const node = items[i] as HTMLElement;
        const r = node.getBoundingClientRect();
        if (r.bottom > wrapTop + 8 && r.top < wrapBottom - 8) {
          const idx = parseInt(node.dataset.msgIndex || '0', 10);
          if (firstVisible < 0) firstVisible = idx;
          lastVisible = idx;
        }
      }

      if (firstVisible < 0 || lastVisible < 0) {
        if (!fallback) return;
        firstVisible = fallback.startIndex;
        lastVisible = fallback.endIndex;
      }

      traceChatScroll('visible-range-dom', { source: 'dom', firstVisible, lastVisible, fallbackStart: fallback?.startIndex, fallbackEnd: fallback?.endIndex });
      const anchorMessage = mergedMessages[firstVisible];
      const anchorNode = Array.from(items).find((item) => parseInt((item as HTMLElement).dataset.msgIndex || '-1', 10) === firstVisible) as HTMLElement | undefined;
      topVisibleItemId.current = anchorMessage?.id ?? null;
      setTopVisibleIndex((current) => current === firstVisible ? current : firstVisible);
      setBottomVisibleIndex((current) => current === lastVisible ? current : lastVisible);
      saveChatScrollSnapshot({ topVisibleIndex: firstVisible, atBottom: isAtBottom.current });
      captureViewportSnapshot({
        anchorMessageId: anchorMessage?.id ?? null,
        anchorOffsetPx: anchorNode ? anchorNode.getBoundingClientRect().top - wrapTop : 0,
        atBottom: isAtBottom.current,
        renderer: mergedMessages.length <= PLAIN_MESSAGE_LIMIT ? 'plain' : 'virtuoso',
        messageCountAtCapture: mergedMessages.length,
      });
    });
  }, [activeSessionId, mergedMessages, saveChatScrollSnapshot, captureViewportSnapshot]);

  const handleAnswerFromCard = useCallback((questionId: string, answer: string) => {
    onAnswerQuestion?.(questionId, answer);
  }, [onAnswerQuestion]);

  const floatingQuestion = pendingQuestion || null;
  const floatingAnswered = null;
  const [minimizedQuestionId, setMinimizedQuestionId] = useState<string | null>(null);
  const isQuestionMinimized = !!floatingQuestion && minimizedQuestionId === floatingQuestion.questionId;

  useEffect(() => {
    if (!floatingQuestion) setMinimizedQuestionId(null);
  }, [floatingQuestion]);

  // Auto-resume banner visibility: show iff (a) the session was auto-resumed
  // recently and (b) the user has NOT yet posted a real (non-hidden) message
  // after that resume. Once the user types something, the banner self-dismisses.
  // See: workspace/decisions/2026-05-10-server-resume-prompt-hidden.md
  const showResumeBanner = useMemo(() => {
    if (!lastAutoResumeAt) return false;
    const resumeMs = new Date(lastAutoResumeAt).getTime();
    if (!Number.isFinite(resumeMs)) return false;
    // Walk messages from the end — fast path for the common case (recent activity).
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'user') continue;
      if (m.metadata?.hidden) continue; // skip the server-resume trigger itself
      if (isAgentOriginMessage(m)) continue; // agent-origin message is visible, but not human control
      if (m.timestamp >= resumeMs) return false; // user already replied
      break; // most recent real user msg is older than resume → keep banner
    }
    return true;
  }, [lastAutoResumeAt, messages]);

  // Toast-style auto-fade for the resume banner: visible for ~7s after the
  // session's lastAutoResumeAt changes, then collapses (opacity + max-height)
  // so the chat reflows naturally. Re-mounts and resets if the session is
  // auto-resumed again later in the same browser tab.
  // See: workspace/decisions/2026-05-10-server-resume-prompt-hidden.md
  const [bannerVisible, setBannerVisible] = useState(true);
  useEffect(() => {
    if (!showResumeBanner || !lastAutoResumeAt) return;
    setBannerVisible(true);
    const fadeTimer = window.setTimeout(() => setBannerVisible(false), 7000);
    return () => window.clearTimeout(fadeTimer);
  }, [showResumeBanner, lastAutoResumeAt]);

  // Dynamic defaultItemHeight: estimate average height from message content types.
  // Static 200px caused big mismatches — short msgs are 60px, code blocks 400px+.
  // This weighted estimate reduces jerk when Virtuoso measures real heights.
  const estimatedItemHeight = useMemo(() => {
    if (mergedMessages.length === 0) return 300;
    let totalEst = 0;
    const sample = mergedMessages.slice(-30); // sample last 30 for perf
    for (const msg of sample) {
      let h = 60; // base: avatar + padding
      for (const block of msg.content) {
        if (block.type === 'text' || block.type === 'commentary') h += Math.min(200, (block.text?.length ?? 0) * 0.15 + 40);
        else if (block.type === 'tool_use') h += 100;
        else if (block.type === 'tool_result') h += 120;
        else h += 80; // thinking, image, etc.
      }
      totalEst += h;
    }
    // Clamp between 150-500 to avoid extremes
    return Math.max(150, Math.min(500, Math.round(totalEst / sample.length)));
  }, [mergedMessages]);

  // Per-message normalize cache keyed by message ID + content reference + timestamp.
  // WeakMap<content array> doesn't work because content is a new array every time
  // (Zustand immutable update). Timestamp must be part of the cache key: turn_done
  // may update only the assistant bubble timestamp while reusing the same content
  // array. If we returned the cached normalized object in that case, the UI would
  // keep showing the first-token time.
  const normalizeCache = useRef(new Map<string, { contentRef: ContentBlock[]; timestamp: number; result: ChatMessage }>());
  useEffect(() => {
    normalizeCache.current.clear();
  }, [activeSessionId]);
  useEffect(() => {
    const cache = normalizeCache.current;
    if (cache.size <= NORMALIZE_CACHE_MAX_ENTRIES) return;
    const keep = new Set(renderMessages.slice(-NORMALIZE_CACHE_MAX_ENTRIES).map((msg) => msg.id));
    for (const key of cache.keys()) {
      if (!keep.has(key)) cache.delete(key);
    }
  }, [activeSessionId, renderMessages.length]);
  const getNormalized = useCallback((msg: ChatMessage): ChatMessage => {
    if (msg.role !== 'assistant') return msg;
    const cache = normalizeCache.current;
    const entry = cache.get(msg.id);
    // Same content array + same timestamp → cache hit (fast path for non-streaming messages)
    if (entry && entry.contentRef === msg.content && entry.timestamp === msg.timestamp) return entry.result;
    // Content or timestamp changed: re-normalize / refresh metadata
    const normalized = { ...msg, content: normalizeContentBlocks(msg.content) };
    cache.set(msg.id, { contentRef: msg.content, timestamp: msg.timestamp, result: normalized });
    return normalized;
  }, []);

  // ── Scroll: always start at bottom ──
  //
  // Root cause of scroll drift: defaultItemHeight (estimated) vs real height mismatch.
  // Virtuoso estimates total scroll height = itemCount × defaultItemHeight.
  // Real messages vary 60-600px. After items render and measure, total height changes
  // but scroll position stays at the old offset → lands in the middle.
  //
  // Fix: rAF-based settle loop. Instead of 4+ fixed setTimeout retries (each causing
  // a visible jerk), we scroll once per animation frame and stop when the position
  // stabilizes. This produces at most 1-2 corrections instead of 6+.

  const scrollToBottom = useCallback(() => {
    if (userScrolledUp.current) return; // honor user intent

    // Use the actual scroller bottom, not `scrollToIndex(lastMessage)`.
    // During active turns the Virtuoso Footer contains the live status/timer
    // below the last message. Aligning the last item to the end can leave that
    // footer outside the viewport, which makes Virtuoso report "not at bottom"
    // and triggers a visible followOutput/atBottomStateChange tug-of-war.
    const scroller = scrollWrapRef.current?.querySelector('[data-testid="virtuoso-scroller"]') as HTMLElement | null;
    if (scroller) {
      const nextTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if (Math.abs(scroller.scrollTop - nextTop) > 1) {
        scroller.scrollTop = nextTop;
      }
      return;
    }

    virtuosoRef.current?.scrollToIndex({
      index: mergedMessages.length - 1,
      align: 'end',
      behavior: 'auto',
    });
  }, [mergedMessages.length]);

  const scrollToBottomRef = useRef(scrollToBottom);
  useEffect(() => { scrollToBottomRef.current = scrollToBottom; }, [scrollToBottom]);

  const {
    conversationViewport,
    getCurrentScrollerMetrics,
    markPinnedToBottom,
    markUserReadingHistory,
  } = useChatScrollController({
    activeSessionId,
    viewportMessageCount: renderMessages.length,
    listMessageCount: mergedMessages.length,
    scrollWrapRef,
    isAtBottomRef: isAtBottom,
    userScrolledUpRef: userScrolledUp,
    setShowJumpToLatest,
  });

  const markHistoryReadingIntent = useCallback((source: 'scroll' | 'jump' = 'scroll') => {
    bottomRearmSuppressedUntil.current = Date.now() + USER_SCROLL_UP_REARM_GRACE_MS;
    if (isStreaming) streamingHistoryReadLock.current = true;
    markUserReadingHistory(source);
  }, [isStreaming, markUserReadingHistory]);

  useEffect(() => {
    if (!isStreaming) streamingHistoryReadLock.current = false;
  }, [isStreaming]);

  // Settle period: suppress atBottomStateChange(false) caused by height drift.
  const settleUntil = useRef(0);
  const switchSettleUntil = useRef(0);

  // Backstop: skeleton 이 영원히 보이는 사고 방지.
  //
  // 시나리오: handleSelectSession 의 cache-miss path 가 setSessionLoading(true)
  // + clearMessages() + fetch /full 한 직후 사용자가 백그라운드로 가면, 브라우저가
  // background tab fetch 를 throttle/연기. 10분쯤 후 돌아왔을 때 fetch 가 여전히
  // pending 이면 sessionLoading 이 true + messages 빈 상태로 머물러 → 스켈레톤
  // 영구 표시. App.tsx 에 AbortController + 10s timeout + finally 가드를 박아
  // 정상 경로는 막았지만, 그래도 마지막 안전장치로 visibility 복귀 시 stuck
  // 검사를 한 번 더 한다. 5초 이상 sessionLoading=true 라면 강제 reset → 사용자가
  // 다시 클릭/새로고침 할 수 있는 상태로 되돌림.
  // 결정문서: workspace/decisions/2026-05-09-mobile-warm-path-rerender.md
  const sessionLoadingSinceRef = useRef<number | null>(null);
  useEffect(() => {
    sessionLoadingSinceRef.current = sessionLoading ? Date.now() : null;
  }, [sessionLoading]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const since = sessionLoadingSinceRef.current;
      if (!since) return;
      if (Date.now() - since > 5000) {
        useChatStore.getState().setSessionLoading(false);
        sessionLoadingSinceRef.current = null;
        console.warn('[chat-panel] sessionLoading was stuck >5s on tab return — forcibly reset');
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // rAF-based settle: scroll to bottom repeatedly until position stabilizes.
  // Stops after position unchanged for 3 consecutive frames, or `duration` max.
  //
  // Re-entrancy: when multiple effects fire in the same tick (session switch +
  // cache-miss + visibility recovery can all overlap), we extend the existing
  // loop's deadline instead of cancelling/restarting. Restarting on every
  // trigger keeps rAF alive far longer than any single `duration` would
  // suggest and worsens jank during tab refocus.
  const settleRafRef = useRef(0);
  const settleDeadlineRef = useRef(0);
  const startSettleLoop = useCallback((duration: number) => {
    const newDeadline = Date.now() + duration;
    // Already running and not yet expired → just extend the deadline.
    if (settleRafRef.current !== 0 && settleDeadlineRef.current > Date.now()) {
      settleDeadlineRef.current = Math.max(settleDeadlineRef.current, newDeadline);
      return;
    }
    cancelAnimationFrame(settleRafRef.current);
    settleDeadlineRef.current = newDeadline;
    let prevScrollTop = -1;
    let stableFrames = 0;
    const tick = () => {
      if (userScrolledUp.current || Date.now() > settleDeadlineRef.current) {
        settleRafRef.current = 0;
        return;
      }
      scrollToBottomRef.current();
      // Check stability: if scrollTop unchanged for 3 frames (~50ms), position settled.
      const el = document.querySelector('[data-virtuoso-scroller]') as HTMLElement | null;
      const currentTop = el?.scrollTop ?? -2;
      if (currentTop === prevScrollTop) {
        stableFrames++;
        if (stableFrames >= 3) { // 3 stable frames → done
          settleRafRef.current = 0;
          return;
        }
      } else {
        stableFrames = 0;
      }
      prevScrollTop = currentTop;
      settleRafRef.current = requestAnimationFrame(tick);
    };
    // Start after a microtask to let React flush
    settleRafRef.current = requestAnimationFrame(tick);
  }, []);

  // Resolve one viewport owner per loaded session. Bottom-owned sessions keep
  // the issue #120 guard: do not restart settle when a streaming turn changes
  // message count, or the scroll-lock shape reported in #120 returns.
  // History-owned revisits disable all bottom
  // settle writers before restoring their stable message anchor.
  const bottomSettledSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeSessionId) {
      bottomSettledSessionRef.current = null;
      restoredSessionRef.current = null;
      return;
    }
    if (mergedMessages.length === 0) {
      bottomSettledSessionRef.current = null;
      return;
    }
    if (bottomSettledSessionRef.current === activeSessionId) return;
    bottomSettledSessionRef.current = activeSessionId;

    // A deep-link effect owns the viewport when the URL names a message.
    if (hasExplicitMessageAnchor) {
      settleUntil.current = 0;
      switchSettleUntil.current = 0;
      cancelAnimationFrame(settleRafRef.current);
      return;
    }

    if (sessionRestorePlan.kind === 'anchor') {
      const restoreAttempt = ++restoreAttemptRef.current;
      restoreInProgressRef.current = true;
      restoredSessionRef.current = activeSessionId;
      userScrolledUp.current = true;
      isAtBottom.current = false;
      setShowJumpToLatest(true);
      conversationViewport.onRestoreAnchorStart();
      settleUntil.current = 0;
      switchSettleUntil.current = 0;
      cancelAnimationFrame(settleRafRef.current);
      traceChatScroll('restore-requested', {
        activeSessionId,
        renderer: mergedMessages.length <= PLAIN_MESSAGE_LIMIT ? 'plain' : 'virtuoso',
        anchorIndex: sessionRestorePlan.anchorIndex,
        anchorMessageId: sessionRestorePlan.snapshot.anchorMessageId,
      });

      const issueAnchorScroll = () => {
        if (mergedMessages.length > PLAIN_MESSAGE_LIMIT) {
          virtuosoRef.current?.scrollToIndex({ index: sessionRestorePlan.anchorIndex, align: 'start', behavior: 'auto' });
        }
      };

      const applyRestore = (allowFallback = false): { applied: boolean; delta: number } => {
        if (restoreAttemptRef.current !== restoreAttempt || useSessionStore.getState().activeSessionId !== activeSessionId) {
          return { applied: false, delta: 0 };
        }
        const wrap = scrollWrapRef.current;
        const scroller = (wrap?.querySelector('[data-testid="virtuoso-scroller"]') as HTMLElement | null)
          || (wrap?.querySelector('[data-chat-scroll="plain"]') as HTMLElement | null);
        const anchor = wrap?.querySelector(`[data-msg-index="${sessionRestorePlan.anchorIndex}"]`) as HTMLElement | null;
        if (!scroller || !anchor) {
          if (!allowFallback) return { applied: false, delta: 0 };
          traceChatScroll('restore-fallback', { activeSessionId, reason: 'anchor-dom-missing', anchorIndex: sessionRestorePlan.anchorIndex });
          restoreInProgressRef.current = false;
          restoredSessionRef.current = null;
          const now = markPinnedToBottom('session');
          settleUntil.current = now + 800;
          switchSettleUntil.current = now + 800;
          scrollToBottom();
          startSettleLoop(800);
          return { applied: false, delta: 0 };
        }
        const delta = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - sessionRestorePlan.snapshot.anchorOffsetPx;
        if (Math.abs(delta) > 1) scroller.scrollTop += delta;
        const metrics = { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight };
        conversationViewport.onRestoreAnchorEnd(metrics);
        traceChatScroll('restore-applied', { activeSessionId, anchorIndex: sessionRestorePlan.anchorIndex, delta });
        return { applied: true, delta };
      };

      issueAnchorScroll();
      let settleRaf = 0;
      let innerRaf = 0;
      let stableFrames = 0;
      const settleStartedAt = Date.now();
      const finishRestore = () => {
        if (restoreAttemptRef.current !== restoreAttempt) return;
        restoreInProgressRef.current = false;
        updateVisibleRangeFromDom({ startIndex: sessionRestorePlan.anchorIndex, endIndex: sessionRestorePlan.anchorIndex });
      };
      const keepAnchorStable = () => {
        if (restoreAttemptRef.current !== restoreAttempt || useSessionStore.getState().activeSessionId !== activeSessionId) return;
        const elapsed = Date.now() - settleStartedAt;
        // Re-issue the virtualized index request early while Virtuoso may still
        // be replacing estimated row heights with measured heights.
        if (elapsed < 650) issueAnchorScroll();
        const result = applyRestore(false);
        if (!result.applied) {
          if (elapsed >= RESTORE_ANCHOR_SETTLE_MAX_MS) applyRestore(true);
          else settleRaf = requestAnimationFrame(keepAnchorStable);
          return;
        }
        stableFrames = Math.abs(result.delta) <= 1 ? stableFrames + 1 : 0;
        if (stableFrames >= RESTORE_ANCHOR_STABLE_FRAMES || elapsed >= RESTORE_ANCHOR_SETTLE_MAX_MS) {
          finishRestore();
          return;
        }
        settleRaf = requestAnimationFrame(keepAnchorStable);
      };
      const raf = requestAnimationFrame(() => {
        if (restoreAttemptRef.current !== restoreAttempt) return;
        issueAnchorScroll();
        innerRaf = requestAnimationFrame(keepAnchorStable);
      });
      return () => {
        if (restoreAttemptRef.current === restoreAttempt) restoreAttemptRef.current++;
        cancelAnimationFrame(raf);
        cancelAnimationFrame(innerRaf);
        cancelAnimationFrame(settleRaf);
      };
    }

    restoredSessionRef.current = null;
    const now = markPinnedToBottom('session');
    traceChatScroll('session-settle', { activeSessionId, messageCount: mergedMessages.length, reason: sessionRestorePlan.reason });
    settleUntil.current = now + 1500;
    switchSettleUntil.current = now + 3500;
    scrollToBottom();
    startSettleLoop(2000); // 2s max settle
    requestAnimationFrame(() => {
      const last = Math.max(0, mergedMessages.length - 1);
      updateVisibleRangeFromDom({ startIndex: last, endIndex: last });
    });
    return () => cancelAnimationFrame(settleRafRef.current);
  }, [activeSessionId, mergedMessages.length, sessionRestorePlan, hasExplicitMessageAnchor, scrollToBottom, startSettleLoop, updateVisibleRangeFromDom, markPinnedToBottom, conversationViewport.onRestoreAnchorStart, conversationViewport.onRestoreAnchorEnd]);

  // ─── Phase 3 메시지 앵커 (issue #11 / #160) ───────────────────────────────
  // URL fragment `#m-<shortId>` 로 진입 시 해당 메시지를 화면 상단 근처로 scroll.
  // 중앙 정렬은 짧은 질문 아래의 긴 답변을 더 두드러지게 만들어, 링크가 다음
  // turn 답변을 가리키는 것처럼 보였다. 대상 row를 잠시 강조해 목적지를 명확히 한다.
  //
  // Race 주의: 같은 ChatPanel 안에 *다른 scroll-to-bottom effects* 가 여럿 있음
  //   - On session switch: settle loop 가 1.5~2s 동안 scrollToBottom 반복
  //   - Cache-miss: messages 처음 도착 시 scrollToBottom
  //   - scrollGen refresh: 백그라운드 update 시 scrollToBottom
  // 이 effects 가 anchor 위치를 덮어쓰지 않도록 가드 ref 들을 명시적으로 reset
  // 한 뒤 여러 timing 으로 scrollToIndex 재시도 — Virtuoso item height 측정 race
  // 와 다른 effect 의 RAF callback 둘 다 흡수.
  const anchorProcessedRef = useRef<string | null>(null);
  const anchorHighlightTimerRef = useRef<number | null>(null);

  // 세션 전환 시 anchor 처리 reset — 새 세션에서 다른 메시지로 anchor 가능.
  useEffect(() => {
    anchorProcessedRef.current = null;
    if (anchorHighlightTimerRef.current !== null) {
      window.clearTimeout(anchorHighlightTimerRef.current);
      anchorHighlightTimerRef.current = null;
    }
    return () => {
      if (anchorHighlightTimerRef.current !== null) {
        window.clearTimeout(anchorHighlightTimerRef.current);
        anchorHighlightTimerRef.current = null;
      }
    };
  }, [activeSessionId]);

  useEffect(() => {
    const tryScroll = () => {
      const m = window.location.hash.match(/^#m-([a-z2-9]{8})$/);
      if (!m) return;
      const shortId = m[1];
      if (anchorProcessedRef.current === shortId) return;
      if (mergedMessages.length === 0) return; // wait for messages
      const idx = mergedMessages.findIndex((msg) => msg.shortId === shortId);
      if (idx < 0) return; // 미로드 (페이지네이션) — backfill 미완 케이스도 동일
      anchorProcessedRef.current = shortId;

      // 가드 — 다른 scroll-to-bottom effects 의 scrollToBottom() 이 *userScrolledUp
      // guard* 를 통과하지 못하도록 + settle loop 즉시 종료.
      userScrolledUp.current = true;
      isAtBottom.current = false;
      conversationViewport.onRestoreAnchorStart();
      settleUntil.current = 0;
      switchSettleUntil.current = 0;

      const highlightTarget = () => {
        const wrap = scrollWrapRef.current;
        const target = wrap?.querySelector(`[data-msg-index="${idx}"]`) as HTMLElement | null;
        if (!target) return;

        const previous = wrap?.querySelector('[data-deep-link-highlight="true"]') as HTMLElement | null;
        if (previous && previous !== target) {
          previous.classList.remove('ring-1', 'ring-primary-500/25', 'bg-primary-500/5', 'rounded-xl');
          previous.removeAttribute('data-deep-link-highlight');
          previous.removeAttribute('tabindex');
        }

        target.classList.add('ring-1', 'ring-primary-500/25', 'bg-primary-500/5', 'rounded-xl');
        target.setAttribute('data-deep-link-highlight', 'true');
        target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });

        if (anchorHighlightTimerRef.current !== null) window.clearTimeout(anchorHighlightTimerRef.current);
        anchorHighlightTimerRef.current = window.setTimeout(() => {
          target.classList.remove('ring-1', 'ring-primary-500/25', 'bg-primary-500/5', 'rounded-xl');
          target.removeAttribute('data-deep-link-highlight');
          target.removeAttribute('tabindex');
          anchorHighlightTimerRef.current = null;
        }, 1_500);
      };

      const doScroll = () => {
        if (mergedMessages.length <= PLAIN_MESSAGE_LIMIT) {
          const wrap = scrollWrapRef.current;
          const scroller = wrap?.querySelector('[data-chat-scroll="plain"]') as HTMLElement | null;
          const target = wrap?.querySelector(`[data-msg-index="${idx}"]`) as HTMLElement | null;
          if (scroller && target) {
            const scrollerRect = scroller.getBoundingClientRect();
            const targetRect = target.getBoundingClientRect();
            scroller.scrollTop += targetRect.top - scrollerRect.top - 24;
            highlightTarget();
          }
          return;
        }
        virtuosoRef.current?.scrollToIndex({ index: idx, align: 'start', behavior: 'auto' });
        requestAnimationFrame(highlightTarget);
      };
      // 여러 timing 재시도 — Virtuoso defaultItemHeight estimation vs 실제 측정
      // 차이로 첫 try 가 잘못된 위치에 떨어질 수 있음. measurement 안정화될 때까지
      // 반복해서 동일 index 로 정렬.
      requestAnimationFrame(doScroll);
      setTimeout(doScroll, 200);
      setTimeout(doScroll, 500);
      setTimeout(doScroll, 1200);
      setTimeout(doScroll, 2500);
    };
    tryScroll();
    // hash 변경 (같은 세션 안에서 anchor 클릭) 도 처리
    window.addEventListener('hashchange', tryScroll);
    return () => window.removeEventListener('hashchange', tryScroll);
  }, [mergedMessages, activeSessionId]);
  // ─── /Phase 3 메시지 앵커 ────────────────────────────────────────────────

  // Cache-miss: messages arrive after empty mount → scroll to bottom.
  const hadMessages = useRef(false);
  useEffect(() => {
    if (activeSessionId) hadMessages.current = false;
  }, [activeSessionId]);
  useEffect(() => {
    const has = mergedMessages.length > 0;
    if (has && !hadMessages.current) {
      hadMessages.current = true;
      if (sessionRestorePlan.kind === 'anchor' || hasExplicitMessageAnchor) return;
      const now = markPinnedToBottom('messages-loaded');
      traceChatScroll('messages-loaded', { activeSessionId, messageCount: mergedMessages.length });
      settleUntil.current = now + 1500;
      scrollToBottom();
      startSettleLoop(1500);
      requestAnimationFrame(() => {
        const last = Math.max(0, mergedMessages.length - 1);
        updateVisibleRangeFromDom({ startIndex: last, endIndex: last });
      });
      return () => cancelAnimationFrame(settleRafRef.current);
    }
    hadMessages.current = has;
  }, [mergedMessages.length, sessionRestorePlan, hasExplicitMessageAnchor, scrollToBottom, startSettleLoop, updateVisibleRangeFromDom, markPinnedToBottom, activeSessionId]);

  // When streaming starts → scroll to bottom only if user hasn't scrolled up
  const prevStreaming = useRef(isStreaming);
  useEffect(() => {
    if (isStreaming && !prevStreaming.current && !userScrolledUp.current) {
      markPinnedToBottom('streaming');
      traceChatScroll('streaming-started', { activeSessionId, messageCount: mergedMessages.length });
      scrollToBottom();
    }
    prevStreaming.current = isStreaming;
  }, [isStreaming, scrollToBottom]);

  // Compact completion preserves an active history-reading intent. Only a
  // bottom-owned viewport is allowed to settle to the latest message.
  const prevCompacting = useRef(isCompacting);
  useEffect(() => {
    if (prevCompacting.current && !isCompacting) {
      traceChatScroll('compact-finished', { activeSessionId, messageCount: mergedMessages.length, userScrolledUp: userScrolledUp.current });
      if (!userScrolledUp.current) {
        const now = markPinnedToBottom('compact');
        settleUntil.current = now + 500;
        scrollToBottom();
        startSettleLoop(800);
      }
    }
    prevCompacting.current = isCompacting;
  }, [isCompacting, scrollToBottom, startSettleLoop]);

  // Background refresh: scroll if user was at bottom OR still within switch settle period.
  const scrollGen = useChatStore((s) => s.scrollGeneration);
  const prevScrollGen = useRef(scrollGen);
  useEffect(() => {
    if (scrollGen !== prevScrollGen.current) {
      prevScrollGen.current = scrollGen;
      if (isAtBottom.current || Date.now() < switchSettleUntil.current) {
        isAtBottom.current = true;
        traceChatScroll('scroll-generation', { scrollGen, activeSessionId, withinSwitchSettle: Date.now() < switchSettleUntil.current });
        settleUntil.current = Math.max(settleUntil.current, Date.now() + 800);
        scrollToBottom();
        startSettleLoop(1000);
      }
    }
  }, [scrollGen, scrollToBottom, startSettleLoop]);

  // ── Message nav bar (above input): jump to previous/next user message ──
  // Sorted ascending list of indices where role === 'user'. Drives the
  // ↑이전 질문 / ↓다음 질문 buttons relative to topVisibleIndex.
  const userMessageIndices = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < mergedMessages.length; i++) {
      if (mergedMessages[i].role === 'user' && !isAgentOriginMessage(mergedMessages[i])) out.push(i);
    }
    return out;
  }, [mergedMessages]);

  const prevUserIndex = useMemo(() => {
    let result = -1;
    for (const i of userMessageIndices) {
      if (i < topVisibleIndex) result = i;
      else break;
    }
    return result;
  }, [userMessageIndices, topVisibleIndex]);

  const nextUserIndex = useMemo(() => {
    // Use bottomVisibleIndex (not topVisibleIndex) so we always skip past
    // user messages already on screen — ↓ should reveal the *next* question
    // below the viewport, not bounce on the one already visible.
    for (const i of userMessageIndices) {
      if (i > bottomVisibleIndex) return i;
    }
    return -1;
  }, [userMessageIndices, bottomVisibleIndex]);

  const jumpToMessage = useCallback((index: number) => {
    if (index < 0) return;
    // Stop auto-scroll-to-bottom; show the "Jump to Latest" button so user
    // can return easily after exploring upward.
    markHistoryReadingIntent('jump');
    traceChatScroll('jump-history', { index, mode: mergedMessages.length <= PLAIN_MESSAGE_LIMIT ? 'plain' : 'virtuoso', messageCount: mergedMessages.length });
    if (mergedMessages.length <= PLAIN_MESSAGE_LIMIT) {
      // PlainMessageList path — find the data-msg-index node and scrollIntoView.
      const wrap = scrollWrapRef.current;
      if (!wrap) return;
      const el = wrap.querySelector(`[data-msg-index="${index}"]`) as HTMLElement | null;
      const scroller = wrap.querySelector('[data-chat-scroll="plain"]') as HTMLElement | null;
      if (el && scroller) fastScrollElementIntoView(scroller, el);
      requestAnimationFrame(() => updateVisibleRangeFromDom({ startIndex: index, endIndex: index }));
    } else {
      // Virtuoso path. `behavior: smooth` uses the browser's native duration,
      // which is noticeably slower than the 0.1s Option/Alt+↑/↓ interaction we
      // want. Use auto for the long virtualized jump, then let the repeated
      // auto scrolls correct measurement drift without a sluggish animation.
      const issueScroll = () => virtuosoRef.current?.scrollToIndex({
        index,
        align: 'start',
        behavior: 'auto',
      });
      issueScroll();
      requestAnimationFrame(() => {
        issueScroll();
        updateVisibleRangeFromDom({ startIndex: index, endIndex: index });
        requestAnimationFrame(() => {
          issueScroll();
          updateVisibleRangeFromDom({ startIndex: index, endIndex: index });
        });
      });
    }
  }, [mergedMessages.length, updateVisibleRangeFromDom, markHistoryReadingIntent]);

  // ── ↑ Jump w/ auto-loadMore ──
  // Memory pagination cap (500 msgs/page) means prevUserIndex eventually goes -1
  // even when older user messages exist on disk. Treat the arrow as "go further
  // back" — if nothing in memory, transparently kick off onLoadMore and resume
  // the jump once the new chunk lands. Cap attempts to avoid runaway loops if
  // a tail of pages happens to contain only assistant messages.
  const pendingPrevJump = useRef(false);
  const pendingPrevAttempts = useRef(0);
  const MAX_PREV_AUTO_LOAD = 5;

  const canJumpPrev =
    prevUserIndex >= 0 || (hasMoreMessages && !!onLoadMore && !!activeSessionId);

  const jumpPrevUser = useCallback(() => {
    if (prevUserIndex >= 0) {
      jumpToMessage(prevUserIndex);
      return;
    }
    if (!hasMoreMessages || !onLoadMore || !activeSessionId) return;
    if (loadingMoreMessages) return; // already loading; useEffect picks up after
    // Pin user-scroll intent BEFORE kicking off auto-loadMore. Without this,
    // the prepend bumps scrollGeneration → bg-refresh useEffect calls
    // scrollToBottom() while userScrolledUp is still false → viewport
    // teleports back to the bottom while we're still waiting for the new
    // chunk. (jumpToMessage normally handles this, but on the loadMore path
    // it isn't called yet.)
    markHistoryReadingIntent('jump');
    traceChatScroll('jump-history', { index: 'load-more-prev', messageCount: mergedMessages.length });
    pendingPrevJump.current = true;
    pendingPrevAttempts.current = 0;
    void onLoadMore(activeSessionId);
  }, [prevUserIndex, jumpToMessage, hasMoreMessages, onLoadMore, activeSessionId, loadingMoreMessages, markHistoryReadingIntent, mergedMessages.length]);

  // After a loadMore completes (loadingMoreMessages: true → false), re-check
  // whether we now have an earlier user message in memory. If yes, jump.
  // If still none and more pages exist, fire another loadMore (up to MAX).
  useEffect(() => {
    if (!pendingPrevJump.current) return;
    if (loadingMoreMessages) return;

    let newPrev = -1;
    for (const i of userMessageIndices) {
      if (i < topVisibleIndex) newPrev = i;
      else break;
    }
    if (newPrev >= 0) {
      pendingPrevJump.current = false;
      pendingPrevAttempts.current = 0;
      // rAF: let anchor-scroll settle (handleStartReached re-pins the previous
      // top message) before we override with our own jump.
      requestAnimationFrame(() => jumpToMessage(newPrev));
      return;
    }

    pendingPrevAttempts.current++;
    if (pendingPrevAttempts.current >= MAX_PREV_AUTO_LOAD) {
      pendingPrevJump.current = false;
      pendingPrevAttempts.current = 0;
      return;
    }
    if (hasMoreMessages && onLoadMore && activeSessionId) {
      void onLoadMore(activeSessionId);
    } else {
      pendingPrevJump.current = false;
      pendingPrevAttempts.current = 0;
    }
  }, [loadingMoreMessages, userMessageIndices, topVisibleIndex, jumpToMessage, hasMoreMessages, onLoadMore, activeSessionId]);

  const jumpNextUser = useCallback(() => {
    if (nextUserIndex >= 0) jumpToMessage(nextUserIndex);
  }, [nextUserIndex, jumpToMessage]);

  // Keyboard shortcuts for chat navigation.
  // - Option/Alt+↑/↓ jumps between user turns.
  // - Plain ↑/↓ scrolls by ~80% of the chat viewport, but does not steal
  //   cursor movement while the user is editing non-empty text.
  // macOS Option is exposed as Alt in KeyboardEvent, so the Alt path covers both.
  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement | HTMLElement => {
      if (!(target instanceof HTMLElement)) return false;
      return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
    };

    const editableHasText = (target: EventTarget | null) => {
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return target.value.length > 0;
      }
      if (target instanceof HTMLElement && target.isContentEditable) {
        return (target.textContent ?? '').length > 0;
      }
      return false;
    };

    const getActiveScroller = () => {
      const wrap = scrollWrapRef.current;
      if (!wrap) return null;
      return (wrap.querySelector('[data-testid="virtuoso-scroller"]') as HTMLElement | null)
        || (wrap.firstElementChild instanceof HTMLElement ? wrap.firstElementChild : null);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;

      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        if (e.key === 'ArrowUp') {
          if (!canJumpPrev) return;
          e.preventDefault();
          e.stopPropagation();
          jumpPrevUser();
          return;
        }

        if (nextUserIndex < 0) return;
        e.preventDefault();
        e.stopPropagation();
        jumpNextUser();
        return;
      }

      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (isEditableTarget(e.target) && editableHasText(e.target)) return;

      const scroller = getActiveScroller();
      if (!scroller) return;
      const delta = scroller.clientHeight * 0.8 * (e.key === 'ArrowDown' ? 1 : -1);
      e.preventDefault();
      e.stopPropagation();
      // Keep this animated: a raw 80%-viewport jump is technically correct but
      // feels like teleporting in long chat logs. Native smooth scrolling gives
      // a short spatial cue without introducing custom animation state.
      scroller.scrollBy({ top: delta, behavior: 'smooth' });

      if (e.key === 'ArrowUp' && !userScrolledUp.current) {
        markHistoryReadingIntent('scroll');
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [canJumpPrev, jumpPrevUser, nextUserIndex, jumpNextUser, markHistoryReadingIntent]);

  // preparing: 사용자가 메시지 보낸 직후 ~ 첫 콘텐츠 도착 전 구간.
  // 이 구간에 아바타 + 점 3개 플레이스홀더를 보여주면 "AI가 듣고 있다"는
  // 느낌을 준다. Pi/Claude 모두 동일. 첫 콘텐츠(thinking 또는 text)가
  // 도착하면 phase가 streaming으로 바뀌어 자동으로 사라진다.
  const showAssistantPlaceholder = displayTurnPhase === 'preparing'
    || displayTurnPhase === 'awaiting_user'
    || displayTurnPhase === 'compacting'
    || displayTurnPhase === 'stalled'
    || displayTurnPhase === 'closing';

  // ── Load More: triggered when user scrolls to top ──
  // Anchor-based scroll restoration: remember the top visible message before prepend,
  // then scroll back to it after new items render. Prevents flicker/jump.
  const pendingAnchor = useRef<string | null>(null);

  const handleStartReached = useCallback(async () => {
    if (!activeSessionId || !onLoadMore || loadingMoreMessages || !hasMoreMessages) return;
    traceChatScroll('start-reached', { activeSessionId, topVisibleIndex, anchorId: topVisibleItemId.current, pendingPrevJump: pendingPrevJump.current });
    // Save anchor before loading — but skip when a prev-jump is in flight.
    // The pendingPrevJump useEffect will issue its own scrollToIndex; running
    // anchor scroll on the same frame causes the message viewport to bounce
    // (and briefly exposes a strip of footer-colored background above the
    // bottom status bar). One authoritative scroll is enough.
    pendingAnchor.current = pendingPrevJump.current ? null : topVisibleItemId.current;
    await onLoadMore(activeSessionId);
  }, [activeSessionId, onLoadMore, loadingMoreMessages, hasMoreMessages, topVisibleIndex]);

  // After prepend completes, scroll back to the anchor message
  useEffect(() => {
    if (!pendingAnchor.current) return;
    const anchorId = pendingAnchor.current;
    const anchorIndex = mergedMessages.findIndex((m) => m.id === anchorId);
    if (anchorIndex >= 0) {
      // Use rAF to ensure DOM is updated with new items before scrolling
      traceChatScroll('anchor-restore', { anchorId, anchorIndex, messageCount: mergedMessages.length });
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({
          index: anchorIndex,
          align: 'start',
          behavior: 'auto',
        });
      });
    }
    pendingAnchor.current = null;
  }, [mergedMessages]);

  // ── Virtuoso: followOutput keeps scroll at bottom during streaming ──
  // Honors user scroll intent: if the user dragged/wheeled upward,
  // we stop following until they return to the bottom.
  const followOutput = useCallback((isAtBottomNow: boolean) => {
    if (userScrolledUp.current || !conversationViewport.shouldAutoFollow()) return false;
    if (isAtBottomNow || isAtBottom.current) return 'auto';
    return false;
  }, [conversationViewport.shouldAutoFollow]);

  // ── Detect explicit user scroll intent on the Virtuoso scroller ──
  // We listen for upward wheel ticks and touchmove deltas. The Virtuoso
  // scroller is the first scrollable child of the wrapper div.
  useEffect(() => {
    const wrap = scrollWrapRef.current;
    if (!wrap) return;
    const scroller = wrap.querySelector('[data-testid="virtuoso-scroller"]') as HTMLElement | null
      || wrap.querySelector('div[style*="overflow"]') as HTMLElement | null;
    if (!scroller) return;

    const captureCurrentViewport = () => {
      // rangeChanged only fires when Virtuoso's rendered range changes. A user
      // can move a long distance inside one tall message without changing that
      // range, so capture on native scroll as well to preserve the relative
      // offset that the restore contract promises.
      updateVisibleRangeFromDom({ startIndex: topVisibleIndex, endIndex: bottomVisibleIndex });
    };

    const markScrolledUp = () => {
      markHistoryReadingIntent('scroll');
      traceChatScroll('user-scroll-up', { topVisibleIndex, messageCount: mergedMessages.length });
      saveChatScrollSnapshot({ topVisibleIndex, atBottom: false });
      captureCurrentViewport();
    };

    const onScroll = () => captureCurrentViewport();
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) markScrolledUp();
    };
    let touchStartY = 0;
    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y - touchStartY > 24) markScrolledUp(); // finger moving down = content moving up (24px threshold for mobile)
    };
    // Keyboard scroll-up
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'PageUp' || e.key === 'ArrowUp' || (e.key === 'Home')) markScrolledUp();
    };

    scroller.addEventListener('scroll', onScroll, { passive: true });
    scroller.addEventListener('wheel', onWheel, { passive: true });
    scroller.addEventListener('touchstart', onTouchStart, { passive: true });
    scroller.addEventListener('touchmove', onTouchMove, { passive: true });
    scroller.addEventListener('keydown', onKeyDown);
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('touchstart', onTouchStart);
      scroller.removeEventListener('touchmove', onTouchMove);
      scroller.removeEventListener('keydown', onKeyDown);
    };
  }, [activeSessionId, mergedMessages.length > 0, saveChatScrollSnapshot, topVisibleIndex, bottomVisibleIndex, markHistoryReadingIntent, mergedMessages.length, updateVisibleRangeFromDom]);

  const jumpToLatest = useCallback(() => {
    streamingHistoryReadLock.current = false;
    const now = markPinnedToBottom('jump-latest');
    traceChatScroll('jump-latest', { messageCount: mergedMessages.length });
    settleUntil.current = now + 800;
    saveChatScrollSnapshot({ topVisibleIndex: Math.max(0, mergedMessages.length - 1), atBottom: true });
    captureViewportSnapshot({
      anchorMessageId: mergedMessages.at(-1)?.id ?? null,
      anchorOffsetPx: 0,
      atBottom: true,
      renderer: mergedMessages.length <= PLAIN_MESSAGE_LIMIT ? 'plain' : 'virtuoso',
      messageCountAtCapture: mergedMessages.length,
    });
    scrollToBottom();
    startSettleLoop(1000);
    requestAnimationFrame(() => {
      scrollToBottom();
      updateVisibleRangeFromDom({
        startIndex: Math.max(0, mergedMessages.length - 1),
        endIndex: Math.max(0, mergedMessages.length - 1),
      });
    });
  }, [scrollToBottom, startSettleLoop, updateVisibleRangeFromDom, saveChatScrollSnapshot, captureViewportSnapshot, mergedMessages, markPinnedToBottom]);

  useEffect(() => {
    const revealRestoredDraft = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string | null }>).detail;
      if (!activeSessionId || detail?.sessionId !== activeSessionId) return;
      // InputBox emits this only for a non-empty draft restored after a real
      // session switch. Reuse the explicit latest-turn path so all viewport
      // ownership flags and snapshots stay consistent.
      jumpToLatest();
    };
    window.addEventListener('tower-composer-draft-restored', revealRestoredDraft);
    return () => window.removeEventListener('tower-composer-draft-restored', revealRestoredDraft);
  }, [activeSessionId, jumpToLatest]);

  useEffect(() => {
    const store = useAiPanelStore.getState();
    if (store.open && store.contextType === 'session' && activeSessionId && store.contextId !== activeSessionId) {
      store.setContext('session', activeSessionId);
      store.setActiveThreadId(null);
      store.setMessages([]);
    }
  }, [activeSessionId]);

  const latestUserIndex = useMemo(() => {
    for (let i = mergedMessages.length - 1; i >= 0; i--) {
      if (mergedMessages[i]?.role === 'user' && !isAgentOriginMessage(mergedMessages[i])) return i;
    }
    return -1;
  }, [mergedMessages]);

  const latestAssistantAfterLatestUserIndex = useMemo(() => {
    if (latestUserIndex < 0) return -1;
    for (let i = mergedMessages.length - 1; i > latestUserIndex; i--) {
      if (mergedMessages[i]?.role === 'assistant') return i;
    }
    return -1;
  }, [latestUserIndex, mergedMessages]);

  const hasAssistantAfterLatestUser = latestAssistantAfterLatestUserIndex >= 0;

  const isTurnVisuallyActive = displayTurnPhase === 'preparing'
    || displayTurnPhase === 'streaming'
    || displayTurnPhase === 'tool_running'
    || displayTurnPhase === 'closing'
    || displayTurnPhase === 'stalled'
    || isStreaming;

  const showInlineAssistantPlaceholder = latestUserIndex >= 0
    && isTurnVisuallyActive
    && !hasAssistantAfterLatestUser;

  // ── Render a single message row for Virtuoso ──
  // normalizeContentBlocks runs once per message via getNormalized cache —
  // not on every Virtuoso re-render. This was the dominant per-token cost.
  const renderMessage = useCallback((index: number) => {
    const raw = mergedMessages[index];
    if (!raw) return null;
    const msg = getNormalized(raw);
    // Group consecutive messages from the same user: tighter gap + the bubble
    // hides its repeated name/time header. See GitHub issue #17.
    const prev = index > 0 ? mergedMessages[index - 1] : null;
    const isUserContinuation = !!prev && raw.role === 'user' && prev.role === 'user'
      && !isAgentOriginMessage(raw) && !isAgentOriginMessage(prev)
      && (raw.username || '') === (prev.username || '');
    const isLatestAssistant = msg.role === 'assistant'
      && index > latestUserIndex
      && isTurnVisuallyActive
      && (
        activeAssistantMessageId
          ? msg.id === activeAssistantMessageId
          : index === latestAssistantAfterLatestUserIndex
      );
    const showPlaceholderAfterThisMessage = showInlineAssistantPlaceholder && index === latestUserIndex;
    return (
      <>
        <div className={`px-3 md:px-6 ${isUserContinuation ? 'pt-0 pb-0.5' : 'py-0.5'}`}>
          <MessageBubble
            key={msg.id}
            message={msg}
            assistantProject={showAssistantCharacter ? activeProject : null}
            onOpenAssistantHome={showAssistantCharacter ? openActiveProjectHome : undefined}
            onFileClick={onFileClick}
            onRetry={onSend}
            onCancelQueued={(messageId) => {
              const text = useChatStore.getState().cancelQueuedMessage(messageId);
              if (text) {
                window.dispatchEvent(new CustomEvent('restore-input-text', { detail: text }));
              }
            }}
            showMetrics={msg.role === 'assistant' && msg.durationMs != null && !(isStreaming && !!activeAssistantMessageId && index === mergedMessages.length - 1)}
            isLastAssistant={isLatestAssistant}
            showTodoSnapshots={isLatestAssistant}
            isContinuation={isUserContinuation}
          />
        </div>
        {showPlaceholderAfterThisMessage && (
          <div className="px-3 md:px-6 py-0.5">
            <AssistantPendingMessageRow />
          </div>
        )}
      </>
    );
  }, [mergedMessages, activeAssistantMessageId, latestUserIndex, latestAssistantAfterLatestUserIndex, showInlineAssistantPlaceholder, displayTurnPhase, isTurnVisuallyActive, isStreaming, onFileClick, onSend, getNormalized, showAssistantCharacter, activeProject, openActiveProjectHome]);

  // ── Header: "Load More" indicator ──
  const headerComponent = useMemo(() => {
    if (!hasMoreMessages) return undefined;
    return (
      <div className="flex justify-center py-3 px-3 md:px-6">
        {loadingMoreMessages ? (
          <div className="flex items-center gap-2 text-[15px] text-gray-500">
            <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
            <span>{t('loadingOlderMessages')}</span>
          </div>
        ) : (
          <div className="text-[13px] text-gray-600">{t('scrollForOlderMessages')}</div>
        )}
      </div>
    );
  }, [hasMoreMessages, loadingMoreMessages]);

  // ── Active turn status / live timer ──
  // Keep this OUTSIDE the Virtuoso/PlainMessageList scroll content. While a run
  // is active the live timer updates every second; if that footer lives inside
  // the virtualized list, Virtuoso re-measures the list bottom and can visibly
  // tug the viewport when the user is already at the bottom.
  const showLiveTurnFooter = isStreaming || showAssistantPlaceholder;
  const activeTurnFooter = useMemo(() => {
    if (!showLiveTurnFooter) return null;
    return (
      <div className="shrink-0 px-3 md:px-6 pt-1 pb-1 flex justify-start pointer-events-none">
        <ActiveTurnStatusPill phase={displayTurnPhase} />
      </div>
    );
  }, [showLiveTurnFooter, displayTurnPhase]);
  const stoppedTurnFooter = useMemo(() => {
    if (showLiveTurnFooter || activeTurnTerminal?.outcome !== 'stopped') return null;
    return <StoppedTurnStatusBox forced={activeTurnTerminal.reason === 'forced_stop'} />;
  }, [activeTurnTerminal?.outcome, activeTurnTerminal?.reason, showLiveTurnFooter]);

  return (
    <div className="flex h-full relative overflow-hidden">
      {/* Main chat area */}
      <div className="flex flex-col flex-1 min-w-0 h-full">

        {/* Conversation branch provenance — immutable source session remains available. */}
        {activeSession?.parentSessionId && activeSession?.sourceMessageId && activeSession?.label === 'conversation_branch' && (
          <ConversationBranchProvenance session={activeSession} />
        )}

        {/* Auto-resume banner — shown when ws-handler.ts injected a hidden
            trigger after a backend restart. Fades out automatically after ~7s
            (toast-style) so it doesn't linger. Also self-dismisses immediately
            if the user posts a real message (showResumeBanner becomes false).
            See: workspace/decisions/2026-05-10-server-resume-prompt-hidden.md */}
        {showResumeBanner && lastAutoResumeAt && (
          <div
            className={`px-3 md:px-6 flex justify-center pointer-events-none overflow-hidden transition-all duration-500 ease-out ${
              bannerVisible ? 'opacity-100 max-h-12 pt-2 pb-1' : 'opacity-0 max-h-0 pt-0 pb-0'
            }`}
          >
            <div
              className="text-[13px] text-gray-400 bg-surface-800/40 border border-surface-700/40 rounded-full px-3 py-1"
              title={t('autoResume.title')}
            >
              <span className="opacity-70 mr-1">↻</span>
              {t('autoResume.label')} ·{' '}
              {new Date(lastAutoResumeAt).toLocaleTimeString(i18n.resolvedLanguage || i18n.language, {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </div>
          </div>
        )}
        {/* Messages area */}
        {renderMessages.length === 0 && renderSessionLoading ? (
          /* Loading skeleton while switching sessions */
          <div className="flex-1 overflow-y-auto px-3 md:px-6">
            <div className="w-full pt-8 space-y-6 animate-pulse">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex gap-3">
                  <div className="w-7 h-7 rounded-full bg-surface-800 shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 bg-surface-800 rounded w-1/3" />
                    <div className="h-3 bg-surface-800/60 rounded w-2/3" />
                    <div className="h-3 bg-surface-800/40 rounded w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : renderMessages.length === 0 ? (
          /* Genuinely empty session — keep the default model; model changes live in the header menu. */
          <EmptyState session={activeSession} project={activeProject} onStart={onSend} />
        ) : mergedMessages.length <= PLAIN_MESSAGE_LIMIT ? (
          /* Plain scroll for small conversations — no virtualization = no mount/unmount flash.
           * Above PLAIN_MESSAGE_LIMIT, switch to Virtuoso earlier so long/visual-heavy
           * sessions don't keep every bubble mounted during streaming. */
          <PlainMessageList
            key={activeSessionId}
            messages={mergedMessages}
            renderMessage={renderMessage}
            headerComponent={headerComponent}
            footerComponent={null}
            scrollWrapRef={scrollWrapRef}
            isStreaming={isStreaming}
            isAtBottomRef={isAtBottom}
            userScrolledUpRef={userScrolledUp}
            showJumpToLatest={showJumpToLatest}
            onJumpToLatest={jumpToLatest}
            onStartReached={handleStartReached}
            onTopVisibleIndexChange={(index) => setTopVisibleIndex((current) => current === index ? current : index)}
            onBottomVisibleIndexChange={(index) => setBottomVisibleIndex((current) => current === index ? current : index)}
            onScrollSnapshotChange={saveChatScrollSnapshot}
            onUserScrollStateChange={setShowJumpToLatest}
            onViewportScroll={conversationViewport.onUserScroll}
            restorePlan={sessionRestorePlan}
            onViewportSnapshot={captureViewportSnapshot}
          />
        ) : (
          /* Virtualized list for large conversations */
          <div ref={scrollWrapRef} className="flex-1 min-h-0 relative">
          <Virtuoso
            key={activeSessionId}
            ref={virtuosoRef}
            className="h-full"
            style={{ overscrollBehavior: 'contain' }}
            data={mergedMessages}
            computeItemKey={(_idx, item) => item.id}
            // Stable message-anchor restoration is safe across changed pixel
            // heights; full Virtuoso snapshots and raw saved indices are not.
            initialTopMostItemIndex={sessionRestorePlan.kind === 'anchor' ? sessionRestorePlan.anchorIndex : mergedMessages.length - 1}
            alignToBottom={true}
            itemContent={(index) => (
              <div data-msg-index={index} data-msg-id={mergedMessages[index]?.id}>
                {renderMessage(index)}
              </div>
            )}
            components={{
              Header: headerComponent ? () => headerComponent : undefined,
              Footer: undefined,
            }}
            rangeChanged={({ startIndex, endIndex }) => {
              traceChatScroll('range-changed', { startIndex, endIndex, messageCount: mergedMessages.length });
              // rangeChanged includes overscan, so don't push it into React
              // state on every scroll tick. On mobile this double-update
              // (overscan fallback → DOM-measured range) can look like a
              // brief flash around the composer/navigation. Use it only as a
              // fallback if DOM measurement cannot find visible rows.
              updateVisibleRangeFromDom({ startIndex, endIndex });
            }}
            followOutput={followOutput}
            atBottomStateChange={(atBottom) => {
              traceChatScroll('at-bottom-change', { atBottom, userScrolledUp: userScrolledUp.current, topVisibleIndex, messageCount: mergedMessages.length });
              const now = Date.now();
              const isWithinUserScrollUpGesture = userScrolledUp.current && atBottom && now < bottomRearmSuppressedUntil.current;
              const isStreamingHistoryReadLocked = userScrolledUp.current && atBottom && isStreaming && streamingHistoryReadLock.current;
              const metrics = getCurrentScrollerMetrics();
              if (metrics && !isWithinUserScrollUpGesture && !isStreamingHistoryReadLocked) conversationViewport.onUserScroll(metrics);
              if (restoreInProgressRef.current) {
                isAtBottom.current = false;
                return;
              }
              if (userScrolledUp.current) {
                if (atBottom) {
                  if (now < bottomRearmSuppressedUntil.current || (isStreaming && streamingHistoryReadLock.current)) {
                    isAtBottom.current = false;
                    setShowJumpToLatest(true);
                    return;
                  }
                  markPinnedToBottom('jump-latest');
                  saveChatScrollSnapshot({ topVisibleIndex, atBottom: true });
                  captureViewportSnapshot({
                    anchorMessageId: mergedMessages.at(-1)?.id ?? null,
                    anchorOffsetPx: 0,
                    atBottom: true,
                    renderer: 'virtuoso',
                    messageCountAtCapture: mergedMessages.length,
                  });
                } else {
                  isAtBottom.current = false;
                }
                return;
              }
              if (!atBottom && (now < settleUntil.current || now < switchSettleUntil.current)) {
                scrollToBottom();
                return;
              }
              isAtBottom.current = atBottom;
              saveChatScrollSnapshot({ topVisibleIndex, atBottom });
              if (atBottom) {
                const anchor = mergedMessages.at(-1);
                captureViewportSnapshot({
                  anchorMessageId: anchor?.id ?? null,
                  anchorOffsetPx: 0,
                  atBottom: true,
                  renderer: 'virtuoso',
                  messageCountAtCapture: mergedMessages.length,
                });
              }
            }}
            atBottomThreshold={80}
            startReached={handleStartReached}
            // Larger viewport overhang reduces drag-select breakage and avoids
            // blank/janky areas when users scroll upward quickly on desktop.
            // top is more important than bottom because reading history upward
            // is the common direction.
            increaseViewportBy={VIRTUOSO_VIEWPORT_OVERHANG}
            defaultItemHeight={estimatedItemHeight}
          />
          {showJumpToLatest && (
            <button
              onClick={jumpToLatest}
              className="absolute bottom-4 right-4 z-20 w-8 h-8 flex items-center justify-center rounded-full bg-primary-600 hover:bg-primary-500 text-white shadow-lg border border-primary-400/40 transition-colors"
              title={t('jumpToLatest')}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              </svg>
            </button>
          )}
          </div>
        )}

        {/* Autocompact banner removed: compacting status is already shown above the input box. */}

        {activeTurnFooter}
        {stoppedTurnFooter}

        {floatingQuestion && (
          <div
            data-testid="floating-question-layer"
            className={isQuestionMinimized
              ? 'pointer-events-none absolute inset-x-0 bottom-[7.25rem] z-30 flex justify-center px-3 md:bottom-[8.5rem] md:px-6'
              : 'pointer-events-none absolute inset-0 z-30 flex items-center justify-center px-3 py-20 md:px-6 md:py-24'}
          >
            <div className={isQuestionMinimized
              ? 'pointer-events-auto w-full max-w-[42rem]'
              : 'pointer-events-auto flex max-h-[min(76vh,44rem)] w-full max-w-[42rem] overscroll-contain rounded-[24px]'}
            >
              <FloatingQuestionCard
                question={floatingQuestion}
                onAnswer={handleAnswerFromCard}
                answered={floatingAnswered}
                minimized={isQuestionMinimized}
                onMinimize={() => setMinimizedQuestionId(floatingQuestion.questionId)}
                onRestore={() => setMinimizedQuestionId(null)}
              />
            </div>
          </div>
        )}

        {/* Input. AskUserQuestion now lives in a non-modal dock layer above it,
            so the chat history remains scrollable behind the question card. */}
        <div className="shrink-0 px-3 md:px-6 pb-2 md:pb-6 relative z-20">
          <InputBox
            onSend={onSend}
            onAbort={onAbort}
            onSafeStop={onSafeStop}
            onAnswerQuestion={handleAnswerFromCard}
            onJumpPrevUser={jumpPrevUser}
            onJumpNextUser={jumpNextUser}
            hasPrevUser={canJumpPrev}
            hasNextUser={nextUserIndex >= 0}
          />
        </div>

      </div>
    </div>
  );
}

/* ── Turn status helpers ── */

function formatActiveTurnDuration(ms: number): string {
  if (ms < 1000) return '0.0s';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${m}m ${rem}s`;
}

function QuestionMarkIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H7a4 4 0 01-4-4V8a4 4 0 014-4h10a4 4 0 014 4v4a4 4 0 01-4 4h-3.5L9 20v-4z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M12 14h.01" />
    </svg>
  );
}

function DancingDotsLogo({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={`tower-dots-logo ${compact ? 'tower-dots-logo--compact' : ''}`}
      aria-hidden="true"
    >
      <span />
      <span />
      <span />
    </span>
  );
}

function SequentialTowerMark({ compact = false }: { compact?: boolean }) {
  return (
    <svg
      className={`tower-sequential-mark ${compact ? 'tower-sequential-mark--compact' : ''}`}
      viewBox="0 0 512 512"
      aria-hidden="true"
      focusable="false"
    >
      <g className="tower-sequential-mark__layer tower-sequential-mark__layer--top">
        <path className="tower-sequential-mark__face-main" d="M256 50 L436 135 L256 220 L76 135Z"/>
      </g>
      <g className="tower-sequential-mark__layer tower-sequential-mark__layer--middle">
        <path className="tower-sequential-mark__face-side" d="M76 187 L256 272 L256 324 L76 239Z"/>
        <path className="tower-sequential-mark__face-main" d="M256 272 L436 187 L436 239 L256 324Z"/>
      </g>
      <g className="tower-sequential-mark__layer tower-sequential-mark__layer--bottom">
        <path className="tower-sequential-mark__face-side" d="M76 291 L256 376 L256 428 L76 343Z"/>
        <path className="tower-sequential-mark__face-main" d="M256 376 L436 291 L436 343 L256 428Z"/>
      </g>
    </svg>
  );
}

function TowerMarkIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={`tower-shaded-mark ${className}`.trim()} viewBox="0 0 512 512" aria-hidden="true" focusable="false">
      <path className="tower-shaded-mark__face-top" d="M256 50 L436 135 L256 220 L76 135Z"/>
      <path className="tower-shaded-mark__face-side" d="M76 187 L256 272 L256 324 L76 239Z"/>
      <path className="tower-shaded-mark__face-main" d="M256 272 L436 187 L436 239 L256 324Z"/>
      <path className="tower-shaded-mark__face-side" d="M76 291 L256 376 L256 428 L76 343Z"/>
      <path className="tower-shaded-mark__face-main" d="M256 376 L436 291 L436 343 L256 428Z"/>
    </svg>
  );
}

function StaticTowerMark() {
  return (
    <span className="tower-status-mark" aria-hidden="true">
      <TowerMarkIcon className="tower-status-mark__icon" />
    </span>
  );
}

function pickActiveTurnStatusLine(lines: string[], seed?: number | null): string {
  const n = seed && Number.isFinite(seed) ? seed : Date.now();
  const idx = Math.abs(Math.floor(n / 1000)) % lines.length;
  return lines[idx];
}

function StoppedTurnStatusBox({ forced }: { forced: boolean }) {
  const { t } = useTranslation('chat');
  return (
    <div className="shrink-0 px-3 md:px-6 pt-1 pb-1 flex justify-start" data-testid="turn-stopped-status">
      <div className="inline-flex max-w-full items-start gap-2 rounded-xl border border-surface-300 bg-surface-100 px-3 py-2 text-[13px] text-surface-700 shadow-sm dark:border-surface-700 dark:bg-surface-900/80 dark:text-surface-300">
        <span className="mt-0.5 text-[10px] text-surface-500" aria-hidden="true">■</span>
        <span>
          <strong className="font-semibold text-surface-900 dark:text-surface-100">{t('stoppedTurn.title')}</strong>
          <span className="ml-1">{forced ? t('stoppedTurn.forcedHint') : t('stoppedTurn.savedHint')}</span>
        </span>
      </div>
    </div>
  );
}

function ActiveTurnStatusPill({ phase }: { phase: TurnPhase }) {
  const { t } = useTranslation('chat');
  const statusLines = t('activeTurnStatusLines', { returnObjects: true }) as string[];
  const isAwaitingUser = phase === 'awaiting_user';
  const isStreaming = useChatStore((s) => s.isStreaming);
  const turnStartTime = useChatStore((s) => s.turnStartTime);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isStreaming || !turnStartTime) {
      setElapsed((current) => (current === 0 ? current : 0));
      return;
    }
    const nextElapsed = () => Math.max(0, serverNowMs() - turnStartTime);
    setElapsed(nextElapsed());
    const iv = setInterval(() => setElapsed(nextElapsed()), 1000);
    return () => clearInterval(iv);
  }, [isStreaming, turnStartTime]);

  const statusLine = useMemo(
    () => phaseLabel(t, phase, statusLines, turnStartTime),
    [isAwaitingUser, phase, statusLines, t, turnStartTime],
  );

  return (
    <div className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1.5 text-[13px] font-medium shadow-[0_10px_30px_rgba(0,0,0,0.18)] backdrop-blur-xl ${
      isAwaitingUser
        ? 'tone-warning tone-bg-soft tone-border tone-text'
        : 'tower-active-turn-pill'
    }`}>
      {isAwaitingUser
        ? <QuestionMarkIcon className="tone-warning tone-text h-3.5 w-3.5" />
        : <StaticTowerMark />}
      <span className="tracking-[-0.01em]">{statusLine}</span>
      {!isAwaitingUser && elapsed > 0 && (
        <>
          <span className="tower-active-turn-pill__dot">·</span>
          <span className="tower-active-turn-pill__time tabular-nums">{formatActiveTurnDuration(elapsed)}</span>
        </>
      )}
    </div>
  );
}

function phaseLabel(t: (key: string) => string, phase: TurnPhase, statusLines: string[], seed?: number | null): string {
  if (phase === 'streaming') return pickActiveTurnStatusLine(statusLines, seed);
  const phaseKeys: Partial<Record<TurnPhase, string>> = {
    queued: 'queued', preparing: 'preparing', tool_running: 'tool_running', stalled: 'stalled',
    closing: 'closing', awaiting_user: 'awaiting_user', compacting: 'compacting', done: 'done',
    stopped: 'stopped', error: 'error',
  };
  return t(`turnPhase.${phaseKeys[phase] || 'working'}`);
}

function AssistantPendingMessageRow() {
  const { t } = useTranslation('chat');
  return (
    <div className="flex gap-3 py-5 justify-start group/message">
      <div className="flex flex-col items-center gap-1 shrink-0 mt-0.5">
        <span className="tower-assistant-mark tower-assistant-mark--active" title="Tower AI" aria-label="Tower AI">
          <SequentialTowerMark compact />
        </span>
      </div>
      <div className="min-w-0 overflow-hidden flex-1">
        <div className="relative min-h-7 space-y-2">
          <span className="sr-only">{t('turnPhase.pendingAssistant')}</span>
        </div>
      </div>
    </div>
  );
}

function AssistantPlaceholder({ phase }: { phase: TurnPhase }) {
  const { t } = useTranslation('chat');
  const statusLines = t('activeTurnStatusLines', { returnObjects: true }) as string[];
  const isCompacting = phase === 'compacting';
  const isAwaitingUser = phase === 'awaiting_user';
  return (
    <div className="flex gap-3 py-5">
      <div className={`w-7 h-7 rounded-full border flex items-center justify-center text-[11px] font-bold shrink-0 mt-0.5 select-none shadow-[0_8px_24px_rgba(0,0,0,0.20)] ${
        isCompacting || isAwaitingUser
          ? 'tone-warning tone-bg-soft tone-border tone-text'
          : 'bg-white/92 border-primary-500/25 text-primary-700 ring-1 ring-primary-500/10 dark:bg-[#071012]/90 dark:border-primary-400/20 dark:text-primary-300 dark:ring-primary-400/10'
      }`}>
        {isCompacting ? 'CTX' : isAwaitingUser ? <QuestionMarkIcon className="h-4 w-4" /> : <StaticTowerMark />}
      </div>
      <div>
        <div className={`flex items-center gap-2 min-h-10 px-4 py-2 rounded-2xl rounded-tl-sm border w-fit text-[15px] shadow-[0_12px_32px_rgba(0,0,0,0.16)] backdrop-blur-xl ${
          isCompacting || isAwaitingUser
            ? 'tone-warning tone-bg-soft tone-border tone-text'
            : 'bg-white/92 border-primary-500/20 text-primary-900 shadow-[0_12px_32px_rgba(15,23,42,0.10)] dark:bg-[#071012]/82 dark:border-primary-400/12 dark:text-primary-100/88 dark:shadow-[0_12px_32px_rgba(0,0,0,0.20)]'
        }`}>
          {isAwaitingUser
            ? <QuestionMarkIcon className="tone-warning tone-text h-4 w-4" />
            : isCompacting
              ? <DancingDotsLogo compact />
              : <SequentialTowerMark compact />}
          <span>{phaseLabel(t, phase, statusLines)}</span>
        </div>
        {isAwaitingUser && (
          <div className="tone-warning tone-text mt-1.5 text-[13px] opacity-80 pl-1">
            {t('turnPhase.answerToContinue')}
          </div>
        )}
        {isCompacting && (
          <div className="mt-1.5 text-[13px] text-gray-500 pl-1">
            {t('turnPhase.compactingHint')}
          </div>
        )}
        <TurnMetricsBar />
      </div>
    </div>
  );
}

/* ── Empty State ── */

function TowerLearningVisual() {
  const { t } = useTranslation('chat');
  return (
    <div className="tower-empty-visual" aria-hidden="true">
      <div className="tower-empty-visual__halo" />
      <div className="tower-empty-visual__orbit tower-empty-visual__orbit--outer">
        <span className="tower-empty-visual__node tower-empty-visual__node--top" />
        <span className="tower-empty-visual__node tower-empty-visual__node--right" />
        <span className="tower-empty-visual__node tower-empty-visual__node--bottom" />
        <span className="tower-empty-visual__node tower-empty-visual__node--left" />
      </div>
      <div className="tower-empty-visual__orbit tower-empty-visual__orbit--inner">
        <span className="tower-empty-visual__spark tower-empty-visual__spark--a" />
        <span className="tower-empty-visual__spark tower-empty-visual__spark--b" />
        <span className="tower-empty-visual__spark tower-empty-visual__spark--c" />
      </div>
      <span className="tower-empty-visual__label tower-empty-visual__label--knowledge">{t('emptyState.visualKnowledge')}</span>
      <span className="tower-empty-visual__label tower-empty-visual__label--tools">{t('emptyState.visualTools')}</span>
      <span className="tower-empty-visual__label tower-empty-visual__label--files">{t('emptyState.visualFiles')}</span>
      <span className="tower-empty-visual__label tower-empty-visual__label--agents">AI</span>
      <div className="tower-empty-visual__core">
        <span className="tower-empty-visual__bar tower-empty-visual__bar--1" />
        <span className="tower-empty-visual__bar tower-empty-visual__bar--2" />
        <span className="tower-empty-visual__bar tower-empty-visual__bar--3" />
      </div>
    </div>
  );
}

function EmptyState({ session, project, onStart }: {
  session: import('@tower/shared').SessionMeta | null;
  project: import('@tower/shared').Project | null;
  onStart: (message: string) => void;
}) {
  const { t } = useTranslation('chat');
  const emptyStatePrompts = t('emptyState.prompts', { returnObjects: true }) as string[];
  const agentStarters = t('emptyState.agentStarters', { returnObjects: true }) as string[];
  const sessions = useSessionStore((s) => s.sessions);
  const [guideSeen, setGuideSeen] = useState(() => hasSeenTowerGuide());
  const currentUsername = typeof window !== 'undefined' ? localStorage.getItem('username') : null;
  const hasOwnSession = !!currentUsername && sessions.some((session) => session.ownerUsername === currentUsername);
  const shouldShowGuideCta = !guideSeen || !hasOwnSession;
  useEffect(() => {
    const update = () => setGuideSeen(hasSeenTowerGuide());
    window.addEventListener(TOUR_STATE_CHANGED_EVENT, update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(TOUR_STATE_CHANGED_EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, []);
  const startTour = () => window.dispatchEvent(new CustomEvent('tower-start-tour', { detail: { tourId: 'beginner' } }));
  const startChatGuide = () => {
    markTowerGuideSeen();
    window.dispatchEvent(new CustomEvent('restore-input-text', { detail: '/tower-intro ' }));
  };
  if (session?.agentCreationCommandId && project) {
    const teammateName = project.agent?.displayName || project.name;
    return (
      <div className="flex-1 overflow-y-auto px-3 md:px-6">
        <div className="mx-auto flex min-h-full max-w-xl flex-col items-center justify-center py-10 text-center">
          <AgentIdentityAvatar project={project} className="h-20 w-20" />
          <div className="mt-5 text-xs font-bold uppercase tracking-[0.16em] text-primary-300">{t('emptyState.firstTask')}</div>
          <h2 className="mt-2 text-2xl font-black tracking-tight text-gray-100">{t('emptyState.assignFirstTask', { name: teammateName })}</h2>
          <p className="mt-2 max-w-lg text-[15px] leading-6 text-gray-400">
            {t('emptyState.firstTaskHint')}
          </p>
          <div className="mt-5 grid w-full gap-2 sm:grid-cols-3">
            {agentStarters.map((starter) => (
              <button
                key={starter}
                type="button"
                onClick={() => onStart(starter)}
                className="rounded-2xl border border-surface-700 bg-surface-900/70 px-4 py-3 text-sm font-semibold text-gray-200 transition hover:border-primary-500/50 hover:bg-primary-500/10"
              >
                {starter}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto px-3 md:px-6">
      <div className="flex min-h-full flex-col items-center justify-center py-10 text-center max-w-2xl mx-auto">
        <TowerLearningVisual />
        <h2 className="mt-5 text-3xl font-bold text-gray-100 tracking-tight">{t('emptyState.headline')}</h2>
        <p className="mt-2 max-w-xl text-[16px] leading-relaxed text-gray-400">
          {t('emptyState.description')}
          <br className="hidden sm:block" />
          {t('emptyState.descriptionFollowup')}
        </p>
        <div className="mt-5 flex max-w-xl flex-wrap justify-center gap-2">
          {emptyStatePrompts.map((prompt) => (
            <span
              key={prompt}
              className="rounded-full border border-surface-700/65 bg-surface-900/60 px-3 py-1.5 text-[14px] font-medium text-gray-300 shadow-sm"
            >
              {prompt}
            </span>
          ))}
        </div>
        <p className="mt-4 text-[13px] text-gray-400">
          {t('emptyState.helpPrefix')} <span className="font-medium text-gray-300">/tower-intro</span> {t('emptyState.helpMiddle')} <span className="font-medium text-gray-300">/</span> {t('emptyState.helpSuffix')}
        </p>
        {shouldShowGuideCta && (
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={startTour}
              className="rounded-full border border-primary-500/30 bg-primary-500/10 px-3.5 py-1.5 text-[13px] font-semibold text-primary-300 transition-colors hover:border-primary-500/50 hover:bg-primary-500/15"
            >
              {t('emptyState.startGuide')}
            </button>
            <button
              type="button"
              onClick={startChatGuide}
              className="rounded-full border border-surface-700/70 bg-surface-900/50 px-3.5 py-1.5 text-[13px] font-semibold text-gray-300 hover:border-surface-600 hover:bg-surface-800/70 hover:text-gray-100"
            >
              {t('emptyState.askInChat')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
