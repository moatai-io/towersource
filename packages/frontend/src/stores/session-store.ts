import { create } from 'zustand';
import { applyTurnTerminal, type TurnTerminalEvent, type TurnTerminalProjection } from '../features/session-run-state/turn-terminal-projection';
import { useRoomStore } from './room-store';
import { dedupeSessionsById, addSessionIfNew } from '../utils/session-filters';
import { applyServerLatestAttention, loadLatestAttentionFromServer, loadLatestAttentionState, saveLatestAttentionState } from '../utils/latest-session-persistence';
export type { SessionMeta } from '@tower/shared';
import type { SessionMeta } from '@tower/shared';

const LAST_TURN_PREVIEW_MAX_CHARS = 8_000;
const LAST_TURN_PREVIEW_PER_MESSAGE_MAX_CHARS = 4_000;

function clampLastTurnPreview(text: string, maxChars = LAST_TURN_PREVIEW_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n\n…`;
}

function sortSessionsByActivity(sessions: SessionMeta[]): SessionMeta[] {
  return dedupeSessionsById(sessions).sort((a, b) => {
    const at = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const bt = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return bt - at;
  });
}

export type MobileTab = 'sessions' | 'ai' | 'files' | 'edit' | 'pins' | 'board' | 'schedule' | 'channel' | 'work';

/**
 * Left drawer/rail surface.
 *
 * Naming contract:
 * - `sessions` is the AI navigation surface: teammate rail, Work/AI Team
 *   first-level scopes, and conversation/session lists. It is not merely a
 *   legacy "sessions tab" in the product sense.
 * - `rooms` is a legacy compatibility identifier for preserved internal-channel
 *   links. It is not an active navigation surface and renders retirement guidance.
 * - `files`, `prompts`, `pins`, and `history` are non-primary left-panel
 *   utility surfaces retained for focused workflows.
 */
export type SidebarTab = 'sessions' | 'files' | 'prompts' | 'pins' | 'rooms' | 'history';

/**
 * Main body rendering surface.
 *
 * Naming contract:
 * - `chat` is the AI conversation surface. It may be reached from the Top
 *   navigation's AI tab and from the mobile bottom `ai` tab.
 * - `aiTeam` is only the full AI Team home/directory surface. It is not the
 *   Top navigation AI tab and not the AI navigation drawer itself.
 * - `work` is the full Work history surface. It is separate from live
 *   `TodoWrite`/Work Steps and from the AI navigation's `work` scope.
 * - `rooms` remains only so preserved `/r/` and `/rooms/` links can resolve to
 *   `RetiredChannelNotice`; new product flows must not navigate to it.
 */
export type ActiveView = 'chat' | 'aiTeam' | 'kanban' | 'history' | 'rooms' | 'files' | 'projectFiles' | 'favorites' | 'inbox' | 'work' | 'schedules' | 'automations' | 'aiServices' | 'beta';

/**
 * A cached "last AI turn text" per session — populated live from WebSocket
 * tower_message events for ALL sessions (even background ones).
 *
 * Why it exists: Inbox cards need the latest assistant response to preview.
 * Without this cache, InboxPanel fires a REST fetch after the card appears,
 * which is slow for long task sessions (limit=500, often takes seconds) and
 * shows stale content when the same session re-completes. With this cache,
 * the text is already in memory the moment the card appears.
 */
export interface LastTurnCacheEntry {
  /** The full assistant text for the last turn, extracted from all text blocks. */
  text: string;
  /** When the last streaming update arrived (not session.updatedAt). */
  updatedAt: number;
  /** Set when turn_done/engine_done has been observed; text is final. */
  finalized: boolean;
  /**
   * Per-msgId text accumulator for multi-turn tool cycles.
   * Each assistant message in a turn has a different msgId.
   * We track each msgId's text separately, then join them for the final `text`.
   * This prevents the "replace" problem where only the last assistant msg shows.
   */
  msgTexts?: Record<string, string>;
}

interface SessionState {
  sessions: SessionMeta[];
  activeSessionId: string | null;
  /** Session whose ChatPanel is actually foreground in the main tab shell. */
  visibleChatSessionId: string | null;
  streamingSessions: Set<string>;
  unreadSessions: Set<string>;
  /** Authoritative Pi root-turn terminal result, keyed by session. */
  turnTerminalBySession: Record<string, TurnTerminalProjection>;
  /** sessionId → true once the session has appeared in Latest until user dismisses it. */
  recentlyReadSessionUntil: Record<string, number>;
  /** sessionId → last-turn text cache (see LastTurnCacheEntry) */
  lastTurnTextBySession: Record<string, LastTurnCacheEntry>;
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  lastSidebarTab: SidebarTab;
  searchQuery: string;
  isMobile: boolean;
  mobileTab: MobileTab;
  mobileContextOpen: boolean;
  mobileTabBeforeContext: MobileTab;  // 파일 열기 전 탭 기억 (뒤로가기용)
  activeView: ActiveView;

  // Inbox → ChatPanel pending reply queue (set in InboxPanel, consumed in ChatPanel)
  pendingReplies: Record<string, string>;
  setPendingReply: (sessionId: string, text: string) => void;
  clearPendingReply: (sessionId: string) => void;

  setSessions: (sessions: SessionMeta[]) => void;
  setRecentSessions: (sessions: SessionMeta[]) => void;
  mergeSessions: (sessions: SessionMeta[]) => void;
  hydratedProjectSessionIds: Set<string>;
  projectSessionsLoading: Set<string>;
  hydrateProjectSessions: (projectId: string, options?: { force?: boolean }) => Promise<void>;
  resetProjectSessionHydration: () => void;
  hydrateLatestAttentionFromServer: () => Promise<void>;
  setActiveSessionId: (id: string | null) => void;
  setVisibleChatSessionId: (id: string | null) => void;
  addSession: (session: SessionMeta) => void;
  removeSession: (id: string) => void;
  updateSessionMeta: (id: string, updates: Partial<SessionMeta>) => void;
  setSessionStreaming: (id: string, streaming: boolean) => void;
  /** Apply one authoritative Pi root-turn terminal event. */
  setTurnTerminal: (id: string, event: TurnTerminalEvent) => void;
  /** Create completion attention only from an authoritative completed terminal outcome. */
  markSessionCompleted: (id: string) => void;
  markSessionRead: (id: string) => void;
  /**
   * Write/update the cached last-turn text for a session.
   * When msgId is provided, accumulates text across multiple assistant messages
   * in a single turn (multi-turn tool cycles). Without msgId, replaces the entire text.
   */
  setLastTurnText: (sessionId: string, text: string, finalized?: boolean, msgId?: string) => void;
  /** Clear the cached last-turn text (e.g. when a session is deleted). */
  clearLastTurnText: (sessionId: string) => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setLastSidebarTab: (tab: SidebarTab) => void;
  setSearchQuery: (query: string) => void;
  setIsMobile: (v: boolean) => void;
  setMobileTab: (tab: MobileTab) => void;
  setMobileContextOpen: (v: boolean) => void;
  openMobileContext: (trackBrowserHistory?: boolean) => void;   // 현재 탭 기억하고 context panel 열기
  closeMobileContext: (fromPopState?: boolean) => void;  // 기억한 탭으로 복귀
  finishMobileContextInChat: () => void;  // 생성/완료 흐름: history 이동 없이 context를 닫고 chat으로 전환
  setActiveView: (view: ActiveView) => void;
  /** Open the mobile Files drawer as one state transition to avoid intermediate AI Team renders. */
  setMobileFilesNavigationSurface: () => void;
  /**
   * Select the AI conversation/navigation surface without deciding chrome.
   * Callers still choose whether to open/close the drawer or mobile context.
   */
  setAiNavigationSurface: () => void;
}

// Detect mobile at store creation to avoid first-render layout flash
const _initialIsMobile = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches;
const _initialLatestAttention = typeof window !== 'undefined'
  ? loadLatestAttentionState()
  : { unreadSessions: new Set<string>(), recentlyReadSessionUntil: {} };

export const useSessionStore = create<SessionState>((set) => ({
  sessions: [],
  activeSessionId: null,
  visibleChatSessionId: null,
  streamingSessions: new Set(),
  unreadSessions: _initialLatestAttention.unreadSessions,
  turnTerminalBySession: {},
  recentlyReadSessionUntil: _initialLatestAttention.recentlyReadSessionUntil,
  lastTurnTextBySession: {},
  sidebarOpen: true,
  sidebarTab: 'sessions',
  lastSidebarTab: 'sessions',
  searchQuery: '',
  isMobile: _initialIsMobile,
  mobileTab: 'ai',
  mobileContextOpen: false,
  mobileTabBeforeContext: 'ai',
  activeView: 'chat',
  pendingReplies: {},
  hydratedProjectSessionIds: new Set(),
  projectSessionsLoading: new Set(),

  setSessions: (sessions) => {
    set({ sessions: dedupeSessionsById(sessions) });
  },
  setRecentSessions: (sessions) => set((s) => {
    const byId = new Map<string, SessionMeta>();
    for (const session of s.sessions) {
      const belongsToHydratedProject = !!session.projectId && s.hydratedProjectSessionIds.has(session.projectId);
      if (belongsToHydratedProject || session.id === s.activeSessionId) {
        byId.set(session.id, session);
      }
    }
    for (const session of sessions) byId.set(session.id, session);
    return { sessions: sortSessionsByActivity(Array.from(byId.values())) };
  }),
  mergeSessions: (sessions) => set((s) => {
    if (!sessions.length) return s;
    const byId = new Map<string, SessionMeta>();
    for (const session of s.sessions) byId.set(session.id, session);
    for (const session of sessions) byId.set(session.id, session);
    const merged = Array.from(byId.values()).sort((a, b) => {
      const at = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const bt = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return bt - at;
    });
    return { sessions: merged };
  }),
  hydrateProjectSessions: async (projectId, options) => {
    const initial = useSessionStore.getState();
    if (!projectId || initial.projectSessionsLoading.has(projectId)) return;
    if (!options?.force && initial.hydratedProjectSessionIds.has(projectId)) return;

    set((s) => ({ projectSessionsLoading: new Set(s.projectSessionsLoading).add(projectId) }));
    try {
      const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      const params = new URLSearchParams({ projectId });
      const response = await fetch(`/api/sessions?${params.toString()}`, { headers });
      if (!response.ok) throw new Error(`project session hydration failed: ${response.status}`);
      const data = await response.json().catch(() => []);
      if (!Array.isArray(data)) throw new Error('project session hydration returned a non-array payload');

      set((s) => {
        const byId = new Map<string, SessionMeta>();
        for (const session of s.sessions) {
          if (session.projectId !== projectId) byId.set(session.id, session);
        }
        for (const session of data) byId.set(session.id, session);
        const hydratedProjectSessionIds = new Set(s.hydratedProjectSessionIds);
        hydratedProjectSessionIds.add(projectId);
        return {
          sessions: sortSessionsByActivity(Array.from(byId.values())),
          hydratedProjectSessionIds,
        };
      });
    } catch (error) {
      console.warn('[session-store] failed to hydrate project sessions:', error);
    } finally {
      set((s) => {
        const projectSessionsLoading = new Set(s.projectSessionsLoading);
        projectSessionsLoading.delete(projectId);
        return { projectSessionsLoading };
      });
    }
  },
  resetProjectSessionHydration: () => set({
    hydratedProjectSessionIds: new Set(),
    projectSessionsLoading: new Set(),
  }),
  hydrateLatestAttentionFromServer: async () => {
    try {
      const entries = await loadLatestAttentionFromServer();
      const next = applyServerLatestAttention(entries);
      set((s) => {
        const unreadSessions = new Set([...s.unreadSessions, ...next.unreadSessions]);
        const recentlyReadSessionUntil = {
          ...s.recentlyReadSessionUntil,
          ...next.recentlyReadSessionUntil,
        };
        for (const id of unreadSessions) delete recentlyReadSessionUntil[id];
        saveLatestAttentionState(unreadSessions, recentlyReadSessionUntil, { syncServer: false });
        return { unreadSessions, recentlyReadSessionUntil };
      });
    } catch {}
  },
  setActiveSessionId: (id) => set({ activeSessionId: id }),
  setVisibleChatSessionId: (id) => set({ visibleChatSessionId: id }),
  addSession: (session) => set((s) => {
    const updated = addSessionIfNew(s.sessions, session);
    if (updated === s.sessions) return s; // no change — skip rerender
    return { sessions: updated };
  }),
  removeSession: (id) =>
    set((s) => {
      // Also drop any cached last-turn text — otherwise a deleted session's
      // cache entry would linger indefinitely. Mirrors how Set-based state
      // (unreadSessions, streamingSessions) is cleaned up on session lifecycle.
      const next: Record<string, LastTurnCacheEntry> = {};
      for (const [sid, entry] of Object.entries(s.lastTurnTextBySession)) {
        if (sid !== id) next[sid] = entry;
      }
      const recentlyReadSessionUntil = { ...s.recentlyReadSessionUntil };
      delete recentlyReadSessionUntil[id];
      const unreadSessions = new Set(s.unreadSessions);
      unreadSessions.delete(id);
      saveLatestAttentionState(unreadSessions, recentlyReadSessionUntil);
      return {
        sessions: s.sessions.filter((ss) => ss.id !== id),
        unreadSessions,
        turnTerminalBySession: Object.fromEntries(Object.entries(s.turnTerminalBySession).filter(([sid]) => sid !== id)),
        recentlyReadSessionUntil,
        lastTurnTextBySession: next,
      };
    }),
  updateSessionMeta: (id, updates) =>
    set((s) => {
      const idx = s.sessions.findIndex((ss) => ss.id === id);
      if (idx < 0) return s;

      const current = s.sessions[idx];
      const next = { ...current, ...updates, updatedAt: updates.updatedAt ?? current.updatedAt };
      const changed = Object.keys(next).some((key) => {
        const k = key as keyof SessionMeta;
        return next[k] !== current[k];
      });
      if (!changed) return s;

      const sessions = s.sessions.slice();
      sessions[idx] = next;
      return { sessions };
    }),
  setSessionStreaming: (id, streaming) =>
    set((s) => {
      const next = new Set(s.streamingSessions);
      if (streaming) next.add(id);
      else next.delete(id);
      return { streamingSessions: next };
    }),
  setTurnTerminal: (id, event) =>
    set((s) => {
      const isViewingSession = s.visibleChatSessionId === id
        && typeof document !== 'undefined'
        && document.visibilityState === 'visible'
        && (typeof document.hasFocus !== 'function' || document.hasFocus());
      const next = applyTurnTerminal(s.turnTerminalBySession[id], event, isViewingSession);
      return { turnTerminalBySession: { ...s.turnTerminalBySession, [id]: next } };
    }),
  markSessionCompleted: (id) =>
    set((s) => {
      // Completion attention is a durable terminal fact, not a streaming edge.
      // Only the authoritative engine_done(outcome=completed) consumer calls
      // this action. Idle/status/reconnect cleanup must never call it.
      const session = s.sessions.find((ss) => ss.id === id);
      const isViewingSession = s.visibleChatSessionId === id
        && typeof document !== 'undefined'
        && document.visibilityState === 'visible'
        && (typeof document.hasFocus !== 'function' || document.hasFocus());
      if (isViewingSession || s.unreadSessions.has(id)) return s;

      const unreadSessions = new Set(s.unreadSessions);
      unreadSessions.add(id);
      setTimeout(() => {
        useRoomStore.getState().addNotification({
          id: `session-done-${id}-${Date.now()}`,
          userId: 0,
          roomId: null,
          type: 'session_done' as const,
          title: `${session?.name || 'Session'} — done`,
          body: null,
          metadata: { sessionId: id } as Record<string, unknown>,
          read: false,
          createdAt: new Date().toISOString(),
        });
      }, 0);
      saveLatestAttentionState(unreadSessions, s.recentlyReadSessionUntil);
      return { unreadSessions };
    }),
  markSessionRead: (id) =>
    set((s) => {
      const currentTerminal = s.turnTerminalBySession[id];
      const turnTerminalBySession = currentTerminal && !currentTerminal.read
        ? { ...s.turnTerminalBySession, [id]: { ...currentTerminal, read: true } }
        : s.turnTerminalBySession;
      if (!s.unreadSessions.has(id)) return turnTerminalBySession === s.turnTerminalBySession ? s : { turnTerminalBySession };
      const unread = new Set(s.unreadSessions);
      unread.delete(id);
      const recentlyReadSessionUntil = {
        ...s.recentlyReadSessionUntil,
        [id]: 1,
      };
      saveLatestAttentionState(unread, recentlyReadSessionUntil);
      return {
        unreadSessions: unread,
        turnTerminalBySession,
        recentlyReadSessionUntil,
      };
    }),
  setLastTurnText: (sessionId, text, finalized = false, msgId?: string) =>
    set((s) => {
      const prev = s.lastTurnTextBySession[sessionId];

      // When msgId is provided, accumulate text across multiple assistant messages
      // in a single turn (multi-turn tool cycles). Each msgId's text is tracked
      // separately and joined for the composite `text` field.
      if (msgId) {
        // If the previous entry was finalized (turn_done), this is a new turn —
        // reset the accumulator so old turn's text doesn't leak into the new one.
        const prevMsgTexts = (prev?.finalized ? {} : prev?.msgTexts) ?? {};
        const previewText = clampLastTurnPreview(text, LAST_TURN_PREVIEW_PER_MESSAGE_MAX_CHARS);
        // Skip no-op: same msgId with identical text
        if (prevMsgTexts[msgId] === previewText && prev?.finalized === finalized) return s;
        const msgTexts = { ...prevMsgTexts, [msgId]: previewText };
        const compositeText = clampLastTurnPreview(Object.values(msgTexts).filter(Boolean).join('\n\n'));
        return {
          lastTurnTextBySession: {
            ...s.lastTurnTextBySession,
            [sessionId]: { text: compositeText, updatedAt: Date.now(), finalized, msgTexts },
          },
        };
      }

      // Legacy path (no msgId) — simple replace.
      // Skip no-op updates (same text, same finalized flag) to avoid rerendering
      // every subscriber on each streaming token.
      const previewText = clampLastTurnPreview(text);
      if (prev && prev.text === previewText && prev.finalized === finalized) return s;
      return {
        lastTurnTextBySession: {
          ...s.lastTurnTextBySession,
          [sessionId]: { text: previewText, updatedAt: Date.now(), finalized },
        },
      };
    }),
  clearLastTurnText: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.lastTurnTextBySession)) return s;
      const next = { ...s.lastTurnTextBySession };
      delete next[sessionId];
      return { lastTurnTextBySession: next };
    }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  setLastSidebarTab: (tab) => set({ lastSidebarTab: tab }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setIsMobile: (v) => set({ isMobile: v }),
  setMobileTab: (tab) => set({ mobileTab: tab }),
  setMobileContextOpen: (v) => set({ mobileContextOpen: v }),
  openMobileContext: (trackBrowserHistory = true) => {
    // 일반 파일은 브라우저 뒤로가기로 닫는다. 완료 후 자동 전환되는 workflow는 history entry를 만들지 않는다.
    if (trackBrowserHistory) history.pushState({ mobileContext: true }, '');
    set((s) => ({
      mobileTabBeforeContext: s.mobileTab,
      mobileContextOpen: true,
      mobileTab: 'edit',
    }));
  },
  closeMobileContext: (fromPopState?: boolean) => {
    // UI 버튼(←)으로 닫을 때는 pushState로 넣은 항목 제거
    if (!fromPopState && history.state?.mobileContext) {
      history.back();
      return; // popstate 핸들러가 다시 closeMobileContext(true) 호출
    }
    set((s) => {
      const returnTab = s.mobileTabBeforeContext;
      // files/pins/sessions → 사이드바 열기, chat → 사이드바 닫기
      const needsSidebar = returnTab === 'files' || returnTab === 'sessions' || returnTab === 'pins';
      return {
        mobileContextOpen: false,
        mobileTab: returnTab,
        sidebarOpen: needsSidebar,
        ...(returnTab === 'files' && { sidebarTab: 'files' as const }),
        ...(returnTab === 'sessions' && { sidebarTab: 'sessions' as const }),
        ...(returnTab === 'pins' && { sidebarTab: 'pins' as const }),
      };
    });
  },
  finishMobileContextInChat: () => {
    // 생성 성공 같은 자동 전환은 history.back()으로 사용자를 다른 화면에 보내지 않는다.
    if (history.state?.mobileContext) {
      const { mobileContext: _, ...rest } = history.state as Record<string, unknown>;
      history.replaceState(rest, '');
    }
    set({ mobileContextOpen: false, mobileTab: 'ai', mobileTabBeforeContext: 'ai', sidebarOpen: false, activeView: 'chat' });
  },
  setActiveView: (view) => set({ activeView: view }),
  setMobileFilesNavigationSurface: () => set({
    mobileContextOpen: false,
    mobileTab: 'files',
    sidebarTab: 'files',
    activeView: 'chat',
    sidebarOpen: true,
  }),
  setAiNavigationSurface: () => set({ sidebarTab: 'sessions', activeView: 'chat', mobileTab: 'ai' }),
  setPendingReply: (sessionId, text) =>
    set((s) => ({ pendingReplies: { ...s.pendingReplies, [sessionId]: text } })),
  clearPendingReply: (sessionId) =>
    set((s) => {
      const { [sessionId]: _, ...rest } = s.pendingReplies;
      return { pendingReplies: rest };
    }),
}));
