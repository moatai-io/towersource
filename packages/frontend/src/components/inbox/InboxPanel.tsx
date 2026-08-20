import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { useSessionStore } from '../../stores/session-store';
import { useProjectStore } from '../../stores/project-store';
import { useKanbanStore } from '../../stores/kanban-store';
import { useChatStore } from '../../stores/chat-store';
import { RichContent } from '../shared/RichContent';
import type { SessionMeta } from '@tower/shared';
import { RunIndicator } from '../common/RunIndicator';
import { getLatestSessionDismissKey, isLatestSessionDismissed, loadDismissedLatestSessionKeys, saveDismissedLatestSessionKeys } from '../../utils/latest-session-persistence';
import { loadSessionListFilters, matchesSessionListFilters, SESSION_LIST_FILTERS_UPDATED_EVENT } from '../../utils/session-list-filters';

interface LastMessage {
  sessionId: string;
  content: string;
  role: 'user' | 'assistant';
  loadedAt: number;
  /** The session.updatedAt value this cache entry was built from.
   *  Used to invalidate when a new completion lands on the same session. */
  sourceUpdatedAt: string;
}

/* ── Send message directly via global WebSocket ── */
function sendToSession(sessionId: string, message: string) {
  const ws = (window as any).__towerWs as WebSocket | undefined;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('[inbox] WebSocket not available');
    return false;
  }
  const messageId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // Mark session as streaming immediately
  useSessionStore.getState().setSessionStreaming(sessionId, true);
  useSessionStore.getState().updateSessionMeta(sessionId, { updatedAt: new Date().toISOString() });

  ws.send(JSON.stringify({
    type: 'chat',
    message,
    messageId,
    sessionId,
    model: localStorage.getItem('selectedModel') || undefined,
  }));
  return true;
}

interface InboxPanelProps {
  onSelectSession?: (session: SessionMeta) => void;
}

function joinAssistantPreviewText(parts: string[]): string {
  return parts
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

export function InboxPanel({ onSelectSession }: InboxPanelProps = {}) {
  const { t } = useTranslation('layout');
  const sessions = useSessionStore((s) => s.sessions);
  const unreadSessions = useSessionStore((s) => s.unreadSessions);
  const streamingSessions = useSessionStore((s) => s.streamingSessions);
  const markSessionRead = useSessionStore((s) => s.markSessionRead);
  const removeSession = useSessionStore((s) => s.removeSession);
  const setActiveSessionId = useSessionStore((s) => s.setActiveSessionId);
  const setActiveView = useSessionStore((s) => s.setActiveView);
  // Live last-turn text cache populated by useChatRuntime from WebSocket events.
  // This is the primary source for card preview text — REST fetch is fallback.
  const lastTurnTextBySession = useSessionStore((s) => s.lastTurnTextBySession);
  const projects = useProjectStore((s) => s.projects);
  const tasks = useKanbanStore((s) => s.tasks);
  const taskSessionIds = useMemo(() => new Set(tasks.filter(t => t.sessionId).map(t => t.sessionId!)), [tasks]);

  const [lastMessages, setLastMessages] = useState<Record<string, LastMessage>>({});
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [sentSessions, setSentSessions] = useState<Set<string>>(new Set());
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(() => loadDismissedLatestSessionKeys()); // archive/send-dismiss → disappear for this update
  const [sessionFilters, setSessionFilters] = useState(() => loadSessionListFilters());
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set()); // animating out
  const recentlyReadSessionUntil = useSessionStore((s) => s.recentlyReadSessionUntil);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void useSessionStore.getState().hydrateLatestAttentionFromServer();
  }, []);

  useEffect(() => {
    const handleDismissedKeysUpdated = (event: Event) => {
      const keys = (event as CustomEvent<{ keys?: string[] }>).detail?.keys;
      if (Array.isArray(keys)) setDismissedKeys(new Set(keys));
    };
    const handleSessionFiltersUpdated = () => setSessionFilters(loadSessionListFilters());
    window.addEventListener('tower:latest-dismissed-keys-updated', handleDismissedKeysUpdated);
    window.addEventListener(SESSION_LIST_FILTERS_UPDATED_EVENT, handleSessionFiltersUpdated);
    return () => {
      window.removeEventListener('tower:latest-dismissed-keys-updated', handleDismissedKeysUpdated);
      window.removeEventListener(SESSION_LIST_FILTERS_UPDATED_EVENT, handleSessionFiltersUpdated);
    };
  }, []);

  const currentUsername = useMemo(() => localStorage.getItem('username') || '', []);

  const isLatestCandidate = useCallback((session: SessionMeta) => {
    if (!currentUsername) return true;
    const lastUserUsername = (session as SessionMeta & { lastUserUsername?: string | null }).lastUserUsername;
    return (lastUserUsername || session.ownerUsername) === currentUsername;
  }, [currentUsername]);

  // Animate-then-dismiss helper
  const animateDismiss = useCallback((sessionId: string) => {
    setExitingIds((prev) => new Set(prev).add(sessionId));
    const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
    setTimeout(() => {
      setDismissedKeys((prev) => {
        const next = new Set(loadDismissedLatestSessionKeys());
        prev.forEach((value) => next.add(value));
        next.add(session ? getLatestSessionDismissKey(session) : sessionId);
        saveDismissedLatestSessionKeys(next);
        return next;
      });
      setExitingIds((prev) => { const next = new Set(prev); next.delete(sessionId); return next; });
    }, 350); // match animation duration
  }, []);

  // Latest = running, unread-completed, or acknowledged until the user hides it.
  const latestSessions = useMemo(() => {
    return sessions
      .filter((s) => {
        if (!isLatestCandidate(s)) return false;
        if (isLatestSessionDismissed(dismissedKeys, s)) return false;
        const isStreaming = streamingSessions.has(s.id);
        const isUnread = unreadSessions.has(s.id);
        if (!matchesSessionListFilters(s, sessionFilters, { currentUsername, isUnread, isStreaming })) return false;
        return isStreaming || isUnread || !!recentlyReadSessionUntil[s.id];
      })
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [sessions, unreadSessions, streamingSessions, isLatestCandidate, dismissedKeys, recentlyReadSessionUntil, sessionFilters, currentUsername]);

  const allVisibleIds = useMemo(() => {
    const ids = new Set<string>();
    latestSessions.forEach((s) => ids.add(s.id));
    return ids;
  }, [latestSessions]);

  // (sessionId, updatedAt) pairs for visible cards. updatedAt is the cache key —
  // when a session re-completes, updatedAt bumps and we refetch the last turn.
  const visibleSessionStamps = useMemo(() => {
    const stamps: Array<[string, string]> = [];
    for (const s of sessions) {
      if (allVisibleIds.has(s.id)) stamps.push([s.id, s.updatedAt]);
    }
    return stamps;
  }, [sessions, allVisibleIds]);

  // Stable dependency key: "id:updatedAt,id:updatedAt,..."
  // Re-fires the effect on either a new id OR an existing id with a newer updatedAt.
  const visibleStampsKey = useMemo(
    () => visibleSessionStamps.map(([id, u]) => `${id}:${u}`).join(','),
    [visibleSessionStamps]
  );

  // Dedupe in-flight fetches across renders so we never fire twice for the same
  // (sessionId, updatedAt). This is what frees us from having to put lastMessages
  // in the effect deps (which would cause re-fires on every setLastMessages).
  const inflightRef = useRef<Set<string>>(new Set());

  // Load last AI turn — REST fallback only.
  //
  // Primary source is `lastTurnTextBySession` (live WS cache populated by
  // useChatRuntime), which is merged into card render via `effectiveLastMessages`
  // below. This effect only handles sessions the WS cache has NOT seen — typically
  // sessions that completed while this client was disconnected, or tasks kicked
  // off by a teammate on another machine before we connected.
  useEffect(() => {
    const token = localStorage.getItem('token') || '';
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    visibleSessionStamps.forEach(async ([sessionId, updatedAt]) => {
      // Skip REST entirely if the live WS cache already has this session's turn.
      // The render will pick it up via effectiveLastMessages (merge below).
      const wsCached = lastTurnTextBySession[sessionId];
      if (wsCached && wsCached.text) return;

      // REST cache hit (same session.updatedAt we already fetched for).
      const cached = lastMessages[sessionId];
      if (cached && cached.sourceUpdatedAt === updatedAt) return;

      const inflightKey = `${sessionId}:${updatedAt}`;
      if (inflightRef.current.has(inflightKey)) return;
      inflightRef.current.add(inflightKey);

      try {
        // Task sessions can have hundreds of messages (tool cycles);
        // fetch more to capture the full AI output after the initial user prompt.
        const isTask = taskSessionIds.has(sessionId);
        const limit = isTask ? 500 : 50;
        const res = await fetch(`/api/sessions/${sessionId}/messages?limit=${limit}`, { headers });
        if (!res.ok) {
          console.warn(`[inbox] failed to load messages for ${sessionId}: ${res.status}`);
          return;
        }
        const data = await res.json();
        const msgs: any[] = data.messages ?? data;
        if (msgs.length === 0) return;

        // Distinguish real user messages from tool_result messages (both have role: 'user').
        // tool_result messages have content like [{type: "tool_result", ...}] or a parent_tool_use_id.
        const isRealUserMsg = (m: any) => {
          if (m.role !== 'user') return false;
          if (m.parent_tool_use_id) return false; // DB-stored tool_result
          if (Array.isArray(m.content)) {
            // If every block is tool_result → not a real user message
            const hasToolResult = m.content.some((b: any) => b.type === 'tool_result');
            const hasText = m.content.some((b: any) => b.type === 'text' && b.text?.trim());
            if (hasToolResult && !hasText) return false;
          }
          return true;
        };

        // Find the last REAL user message (not tool_result)
        let lastUserIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (isRealUserMsg(msgs[i])) { lastUserIdx = i; break; }
        }

        // Take everything after the last real user message (= full AI turn including tool cycles)
        const lastTurnMsgs = lastUserIdx >= 0 ? msgs.slice(lastUserIdx + 1) : msgs;
        if (lastTurnMsgs.length === 0) return;

        // Concatenate all text blocks from assistant messages in the turn
        const text = joinAssistantPreviewText(
          lastTurnMsgs
            .filter((m: any) => m.role === 'assistant')
            .map((m: any) => {
              if (typeof m.content === 'string') return m.content;
              if (Array.isArray(m.content)) {
                return joinAssistantPreviewText(
                  m.content.map((b: any) => (b.type === 'text' ? b.text : ''))
                );
              }
              return '';
            })
        );

        if (!text) return;

        setLastMessages((prev) => ({
          ...prev,
          [sessionId]: {
            sessionId,
            content: text,
            role: 'assistant',
            loadedAt: Date.now(),
            sourceUpdatedAt: updatedAt,
          },
        }));
      } catch (err) {
        console.warn(`[inbox] error loading messages for ${sessionId}:`, err);
      } finally {
        inflightRef.current.delete(inflightKey);
      }
    });
    // lastMessages + lastTurnTextBySession are intentionally omitted from deps:
    //   - inflightRef handles duplicate-fetch guard across stale closures
    //   - lastTurnTextBySession updates on every streaming token — putting it in
    //     deps would cause the effect to refire constantly during streaming.
    //   - The render reads lastTurnTextBySession directly via `effectiveLastMessages`,
    //     so staleness inside the effect only affects the REST skip heuristic,
    //     not what the user sees.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleStampsKey, taskSessionIds]);

  // Merge source: WS cache (live) overrides REST cache (lastMessages).
  // This is what the render actually reads — so the moment a session's last-turn
  // text arrives via WebSocket, the Inbox card updates with zero REST fetch.
  const effectiveLastMessages = useMemo(() => {
    const merged: Record<string, LastMessage> = { ...lastMessages };
    for (const [sid, cached] of Object.entries(lastTurnTextBySession)) {
      if (!cached?.text) continue;
      // Prefer WS cache over REST cache — WS is always at least as fresh (captured
      // live from the same turn). Don't clobber REST entries that have a matching
      // sourceUpdatedAt if the WS text is identical (no-op).
      const existing = merged[sid];
      if (existing && existing.content === cached.text) continue;
      merged[sid] = {
        sessionId: sid,
        content: cached.text,
        role: 'assistant',
        loadedAt: cached.updatedAt,
        // WS source doesn't track session.updatedAt — use empty sentinel so the
        // REST-cache check (sourceUpdatedAt === updatedAt) never short-circuits
        // on this entry. (Prevents accidentally skipping a later REST re-fetch.)
        sourceUpdatedAt: '',
      };
    }
    return merged;
  }, [lastMessages, lastTurnTextBySession]);

  // Newest first → no auto-scroll needed (already at top)

  const handleArchive = useCallback(async (sessionId: string) => {
    const token = localStorage.getItem('token') || '';
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE', headers });
      if (res.ok) {
        removeSession(sessionId);
        markSessionRead(sessionId);
      }
    } catch {}
  }, [removeSession, markSessionRead]);

  const openSession = useCallback((session: SessionMeta) => {
    markSessionRead(session.id);
    // Use the App-level handleSelectSession which properly loads messages,
    // handles cache, claudeSessionId, etc.
    if (onSelectSession) {
      onSelectSession(session);
    } else {
      // Fallback: manual navigation (shouldn't happen if prop is wired)
      useChatStore.getState().setSessionId(session.id);
      useChatStore.getState().setStreaming(false);
      setActiveSessionId(session.id);
    }
    setActiveView('chat');
    // Persist last-viewed session
    const userId = localStorage.getItem('token') ? JSON.parse(atob(localStorage.getItem('token')!.split('.')[1])).userId : null;
    if (userId) localStorage.setItem(`tower:lastViewed:${userId}`, session.id);
  }, [markSessionRead, setActiveSessionId, setActiveView, onSelectSession]);

  const handleSendReply = useCallback((session: SessionMeta, text: string) => {
    const ok = sendToSession(session.id, text);
    if (ok) {
      // Queue the inbox-origin reply so ChatPanel can render the same text
      // if the user opens the session immediately after sending from Inbox.
      useSessionStore.getState().setPendingReply(session.id, text);
      markSessionRead(session.id);
      // Show user's message in the card briefly, then animate out
      setLastMessages((prev) => ({
        ...prev,
        [session.id]: {
          sessionId: session.id,
          content: text,
          role: 'user',
          loadedAt: Date.now(),
          // Sentinel: empty string never matches a real updatedAt, so the next
          // completion will be fetched fresh instead of reusing this reply stub.
          sourceUpdatedAt: '',
        },
      }));
      setSentSessions((prev) => new Set(prev).add(session.id));
      setReplies((prev) => ({ ...prev, [session.id]: '' }));
      // Animate dismiss after a brief moment so user sees "Sent" state
      setTimeout(() => animateDismiss(session.id), 400);
    }
  }, [markSessionRead, animateDismiss]);

  const unreadCount = latestSessions.filter((s) => unreadSessions.has(s.id)).length;
  const isEmpty = latestSessions.length === 0;

  if (isEmpty) {
    return (
      <div data-testid="inbox-panel" className="flex-1 flex flex-col items-center justify-center gap-3 text-surface-500">
        <svg className="w-10 h-10 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z" />
        </svg>
        <p className="text-[16px]">{t('pendingRepliesView.empty')}</p>
      </div>
    );
  }

  const allCards: Array<{ session: SessionMeta; isUnread: boolean }> = latestSessions
    .map((s) => ({ session: s, isUnread: unreadSessions.has(s.id) }))
    .sort((a, b) => new Date(b.session.updatedAt).getTime() - new Date(a.session.updatedAt).getTime());

  return (
    <div data-testid="inbox-panel" ref={scrollRef} className="flex-1 overflow-y-auto relative z-10">
      {/* Hero header — 존재감 있는 상단 영역 */}
      <div className="px-5 pt-8 pb-5">
        <div className="flex items-center gap-3 mb-1.5">
          <div className="w-9 h-9 rounded-xl bg-primary-600/20 border border-primary-500/30 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z" />
            </svg>
          </div>
          <div>
            <h2 className="text-[20px] font-bold text-gray-100 leading-tight">{t('pendingRepliesView.title')}</h2>
            <p className="text-[14px] text-surface-500 leading-tight">
              {unreadCount > 0
                ? t('pendingRepliesView.summaryUnread', { unread: unreadCount, total: allCards.length })
                : t('pendingRepliesView.summary', { total: allCards.length })}
            </p>
          </div>
          {unreadCount > 0 && (
            <span className="ml-auto text-[13px] font-semibold bg-primary-500/20 text-primary-300 rounded-full px-2.5 py-1 leading-none">
              {t('pendingRepliesView.newCount', { count: unreadCount })}
            </span>
          )}
        </div>
      </div>

      {/* Cards stream — most recent at bottom */}
      <div className="p-4 space-y-4">
        {allCards.map(({ session, isUnread }) => {
          const project = projects.find((p) => p.id === session.projectId);
          const msg = effectiveLastMessages[session.id];
          const replyText = replies[session.id] ?? '';
          const isStreaming = streamingSessions.has(session.id);
          const wasSent = sentSessions.has(session.id);

          const isExiting = exitingIds.has(session.id);

          return (
            <div key={session.id} className={isExiting ? 'inbox-card-exit' : ''}>
              <InboxCard
                session={session}
                projectName={project?.name}
                lastMessage={msg}
                replyText={replyText}
                isUnread={isUnread}
                isStreaming={isStreaming}
                wasSent={wasSent}
                onReplyChange={(text) => setReplies((prev) => ({ ...prev, [session.id]: text }))}
                onOpenSession={() => openSession(session)}
                onDismiss={() => { markSessionRead(session.id); animateDismiss(session.id); }}
                onArchive={() => handleArchive(session.id)}
                onSendReply={(text) => handleSendReply(session, text)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Inbox Card — shows full last message ── */

function InboxCard({
  session,
  projectName,
  lastMessage,
  replyText,
  isUnread,
  isStreaming,
  wasSent,
  onReplyChange,
  onOpenSession,
  onDismiss,
  onArchive,
  onSendReply,
}: {
  session: SessionMeta;
  projectName?: string;
  lastMessage?: LastMessage;
  replyText: string;
  isUnread: boolean;
  isStreaming: boolean;
  wasSent: boolean;
  onReplyChange: (t: string) => void;
  onOpenSession: () => void;
  onDismiss: () => void;
  onArchive: () => void;
  onSendReply: (t: string) => void;
}) {
  const { t } = useTranslation('layout');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    const text = e.currentTarget.value.trim();
    if (e.key === 'Enter' && !e.shiftKey && text) {
      e.preventDefault();
      onSendReply(text);
    }
  };

  // Auto-resize textarea
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onReplyChange(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  };

  const isProactive = session.label === 'proactive';

  return (
    <div className={`rounded-xl overflow-hidden transition-all ${
      isProactive
        ? 'bg-blue-950/30 border border-blue-500/30 hover:border-blue-500/50'
        : isUnread
        ? 'bg-surface-850 border border-primary-500/30 hover:border-primary-500/50'
        : 'bg-surface-850/50 border border-surface-800/50 hover:border-surface-700'
    }`}>
      {/* ── Proactive accent bar ── */}
      {isProactive && (
        <div className="h-0.5 bg-gradient-to-r from-blue-500/80 via-blue-400/60 to-transparent" />
      )}
      {/* ── Header ── */}
      <div className="flex items-center gap-2 px-4 py-2.5 group">
        {isProactive && <span className="text-[14px] shrink-0">💬</span>}
        {!isProactive && isUnread && <div className="w-2 h-2 rounded-full bg-primary-400 shrink-0" />}
        {isStreaming && <RunIndicator size="xs" label={t('pendingRepliesView.sessionRunning')} className="tone-success tone-text shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className={`text-[15px] truncate ${isUnread ? 'font-bold text-gray-100' : 'font-medium text-gray-300'}`}>
              {session.name}
            </span>
            {projectName && (
              <span className="text-[12px] text-surface-600 shrink-0">
                {projectName}
              </span>
            )}
          </div>
          {isProactive && (
            <div className="text-[12px] text-blue-400/70 leading-tight">{t('pendingRepliesView.aiStartedConversation')}</div>
          )}
        </div>
        <span className="text-[13px] text-surface-500 shrink-0">
          {relativeTime(session.updatedAt)}
        </span>
        {/* Hover actions */}
        <div className="flex items-center gap-0.5 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
          <button onClick={onDismiss} className="p-1 text-surface-500 hover:text-gray-300 rounded hover:bg-surface-700/50 transition-colors" title={t('pendingRepliesView.dismiss')} aria-label={t('pendingRepliesView.dismiss')}>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m0 0l-5-5m5 5l5-5" />
            </svg>
          </button>
          <button onClick={onArchive} className="tone-warning p-1 text-surface-500 hover:text-[var(--tone-text)] rounded hover:bg-surface-700/50 transition-colors" title={t('pendingRepliesView.archive')}>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
            </svg>
          </button>
        </div>
        <button
          onClick={onOpenSession}
          className="text-[13px] text-primary-400 hover:text-primary-300 transition-colors shrink-0 ml-1"
        >
          {t('pendingRepliesView.open')} →
        </button>
      </div>

      {/* ── Last message — FULL rich content ── */}
      <div className="px-4 pb-3">
        {lastMessage ? (
          <div>
            {/* Role indicator */}
            <span className={`text-[12px] uppercase tracking-wider mb-1 block ${
              lastMessage.role === 'user' ? 'text-blue-400/60' : 'text-surface-500'
            }`}>
              {lastMessage.role === 'user' ? t('pendingRepliesView.you') : t('pendingRepliesView.ai')}
            </span>
            {lastMessage.role === 'user' ? (
              <div className="text-msg-sub-size leading-relaxed whitespace-pre-wrap text-blue-300/80">
                {lastMessage.content}
              </div>
            ) : (
              <div className="prose prose-invert prose-sm max-w-none text-gray-400 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                <RichContent text={lastMessage.content} />
              </div>
            )}
          </div>
        ) : (
          <div className="h-12 flex items-center">
            <div className="w-4 h-4 border-2 border-surface-600 border-t-surface-400 rounded-full animate-spin" />
          </div>
        )}

        {/* Streaming indicator */}
        {isStreaming && (
          <div className="tone-success tone-text flex items-center gap-2 mt-2 text-[13px] opacity-70">
            <div className="w-3 h-3 border-2 border-[var(--tone-border)] border-t-[var(--tone-text)] rounded-full animate-spin" />
            {t('pendingRepliesView.processing')}
          </div>
        )}

        {/* Sent confirmation */}
        {wasSent && !isStreaming && lastMessage?.role === 'user' && (
          <div className="text-[13px] text-surface-500 mt-1">
            {t('pendingRepliesView.sentWaiting')}
          </div>
        )}
      </div>

      {/* ── Reply input — always visible ── */}
      {!isStreaming && (
        <div className="px-4 py-2 border-t border-surface-800/30 flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={replyText}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={t('pendingRepliesView.replyPlaceholder')}
            rows={1}
            className="flex-1 bg-transparent text-input-size text-gray-300 placeholder-surface-600 resize-none outline-none py-1 leading-relaxed"
            style={{ maxHeight: '120px' }}
          />
          {replyText.trim() && (
            <button
              onClick={() => onSendReply(replyText.trim())}
              className="shrink-0 text-[14px] text-primary-400 hover:text-primary-300 font-medium pb-1 transition-colors"
            >
              {t('pendingRepliesView.send')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Relative time helper ── */

function relativeTime(dateStr: string): string {
  let normalized = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T');
  if (!normalized.endsWith('Z') && !/[+-]\d{2}(:\d{2})?$/.test(normalized)) normalized += 'Z';
  const diff = Date.now() - new Date(normalized).getTime();
  if (isNaN(diff)) return '';
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return i18n.t('pendingRepliesView.justNow', { ns: 'layout' });
  if (mins < 60) return i18n.t('pendingRepliesView.minutesAgo', { ns: 'layout', count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return i18n.t('pendingRepliesView.hoursAgo', { ns: 'layout', count: hours });
  return i18n.t('pendingRepliesView.daysAgo', { ns: 'layout', count: Math.floor(hours / 24) });
}
