import { useEffect, useRef } from 'react';
import { useSessionStore, type ActiveView } from '../stores/session-store';
import { useFileStore, type SystemTabKind } from '../stores/file-store';
import type { SessionMeta } from '@tower/shared';

/**
 * useUrlSync — URL ↔ store 양방향 동기화 (issue #11 Phase 1.2 + Phase 2).
 *
 * The store is the source of truth; the URL is a *mirror*. Scattered
 * `setActiveSessionId` / `setActiveRoomId` / `setActiveView` call sites
 * (Header, Sidebar, RoomList, …) just mutate the store; this hook reflects
 * the result into the address bar.
 *
 * URL 정형:
 *   /r/<roomKey>           — activeView='rooms' + activeRoomId 있음
 *   /s/<sessionKey>        — activeSessionId 있음 (그 외 view)
 *   /?view=<v>             — view 만 활성, deep key 없음
 *   /?system=publishing    — first-class system tab 활성
 *   /                      — 홈
 *
 * `key` 는 두 형태 — short_code (8자, 권장) 또는 raw UUID (36자, 옛 북마크
 * 영구 수용). store 는 항상 UUID 로 식별하고 mirror 시 우선 shortCode 가 있으면
 * 그것으로 표시하여 자연스러운 업그레이드.
 *
 * 결정: workspace/decisions/2026-05-23-url-routing-phase-1.md
 *       workspace/decisions/2026-05-24-url-routing-phase-2-short-code.md
 */

/**
 * Views that get serialized into `?view=`. `chat` is the implicit default,
 * `files` is a transient desktop tree view, and `rooms` gets *path-encoded*
 * (`/r/<key>` or `/?view=rooms`) instead of `?view=rooms` when a specific
 * room is active.
 */
const URL_VIEWS: ReadonlyArray<ActiveView> = [
  'kanban',
  'history',
  'rooms',
  'inbox',
  'work',
  'schedules',
  'automations',
  'beta',
];

/**
 * `/s/<key>` 매칭. key 는 두 형태:
 *   • short_code: 8자 [a-z2-9] (모호문자 0/o, 1/l/i, u 제외)
 *   • UUID:       36자 hex+하이픈
 */
const SESSION_KEY_REGEX = /^\/s\/([a-z2-9]{8}|[0-9a-f-]{36})$/i;

/** `/r/<key>` 매칭 — 채널. key 형태는 세션과 동일. */
const ROOM_KEY_REGEX = /^\/r\/([a-z2-9]{8}|[0-9a-f-]{36})$/i;
/** Legacy room link emitted by old mention notifications before issue #124 fix. */
const LEGACY_ROOM_KEY_REGEX = /^\/rooms\/([a-z2-9]{8}|[0-9a-f-]{36})$/i;
const SYSTEM_TABS: ReadonlyArray<SystemTabKind> = ['publishing', 'projectFiles'];

function appendSearch(path: string, params: Array<[string, string | null]>): string {
  const search = new URLSearchParams();
  for (const [key, value] of params) {
    if (value) search.set(key, value);
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * Build the canonical URL (path + search) for the current store state.
 *
 * 우선순위:
 *   1) activeView==='rooms' && roomKey  →  /r/<roomKey>
 *   2) sessionKey            →  /s/<sessionKey>(?view=<v>&system=<kind>)
 *   3) URL_VIEWS 안 view     →  /?view=<v>(&system=<kind>)
 *   4) system tab            →  /?system=<kind>
 *   5) 그 외                  →  /
 */
export function computeUrl(
  sessionKey: string | null,
  roomKey: string | null,
  activeView: ActiveView,
  systemTab: SystemTabKind | null = null,
): string {
  // 채널 — view='rooms' 이고 특정 room 활성이면 path-encode
  if (activeView === 'rooms' && roomKey) {
    return appendSearch(`/r/${roomKey}`, [['system', systemTab]]);
  }
  const viewParam = URL_VIEWS.includes(activeView) && activeView !== 'rooms' ? activeView : null;
  // 세션 deep link (+ optional view/system query)
  if (sessionKey) {
    return appendSearch(`/s/${sessionKey}`, [['view', viewParam], ['system', systemTab]]);
  }
  // view 만 (rooms 도 포함 — 특정 채널 안 들어간 채널 목록 상태)
  if (URL_VIEWS.includes(activeView)) {
    return appendSearch('/', [['view', activeView], ['system', systemTab]]);
  }
  if (systemTab) {
    return appendSearch('/', [['system', systemTab]]);
  }
  return '/';
}

/**
 * Parse the address bar back into store-shaped fields.
 *   sessionKey / roomKey — 호출자가 store list 에서 매칭해 실제 ID 로 resolve
 *   view                  — `?view=` 또는 path 가 `/r/` 면 'rooms' 강제
 */
export function parseUrl(
  pathname: string,
  search: string,
): { sessionKey: string | null; roomKey: string | null; view: ActiveView | null; systemTab: SystemTabKind | null } {
  const params = new URLSearchParams(search);
  const sys = params.get('system');
  const systemTab = sys && (SYSTEM_TABS as ReadonlyArray<string>).includes(sys) ? (sys as SystemTabKind) : null;
  const roomMatch = pathname.match(ROOM_KEY_REGEX) ?? pathname.match(LEGACY_ROOM_KEY_REGEX);
  if (roomMatch) {
    // `/r/<key>` 는 activeView='rooms' 함의 — view query 무시.
    // `/rooms/<key>` 는 옛 멘션 알림 actionUrl 호환용 읽기 alias이며,
    // store→URL mirror 단계에서 canonical `/r/<key>` 로 정규화된다.
    return { sessionKey: null, roomKey: roomMatch[1], view: 'rooms', systemTab };
  }
  const sessionMatch = pathname.match(SESSION_KEY_REGEX);
  const sessionKey = sessionMatch ? sessionMatch[1] : null;
  const v = params.get('view');
  const view = v && (URL_VIEWS as ReadonlyArray<string>).includes(v) ? (v as ActiveView) : null;
  return { sessionKey, roomKey: null, view, systemTab };
}

/** URL key (short_code 또는 UUID) 로 sessions 목록에서 매칭. */
export function findSessionByKey(sessions: SessionMeta[], key: string): SessionMeta | undefined {
  const lower = key.toLowerCase();
  return sessions.find((s) => s.id.toLowerCase() === lower || s.shortCode?.toLowerCase() === lower);
}

/** active session 의 URL 표시용 key (shortCode 우선, 없으면 UUID fallback). */
function urlKeyForSession(sessions: SessionMeta[], activeSessionId: string | null): string | null {
  if (!activeSessionId) return null;
  const s = sessions.find((ss) => ss.id === activeSessionId);
  return s?.shortCode || activeSessionId;
}

interface PopHandlers {
  /** popstate 가 다른 세션 key 로 landing — 그 세션 로드 또는 null 이면 clear. */
  onPopSession: (sessionKey: string | null) => void;
  /** popstate 가 다른 room key 로 landing — 그 채널 활성화 또는 null 이면 clear. */
  onPopRoom: (roomKey: string | null) => void;
}

/**
 * Mount once near the app root.
 *
 * `enabled` should be false until both sessions and rooms have loaded, so we
 * don't clobber a `/s/<key>` 또는 `/r/<key>` deep link before it has been
 * restored into the store.
 */
export function useUrlSync(handlers: PopHandlers, enabled: boolean): void {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeView = useSessionStore((s) => s.activeView);
  const sessions = useSessionStore((s) => s.sessions);
  const systemTabs = useFileStore((s) => s.systemTabs);
  const activeSystemTabId = useFileStore((s) => s.activeSystemTabId);
  const handlingPopRef = useRef(false);
  const popClearTimerRef = useRef<number | null>(null);

  // store → URL (mirror)
  useEffect(() => {
    if (!enabled) return;
    const sessionKey = urlKeyForSession(sessions, activeSessionId);
    const systemTab = systemTabs.find((t) => t.id === activeSystemTabId)?.kind ?? null;
    const baseTarget = computeUrl(sessionKey, null, activeView, systemTab);
    const currentParams = new URLSearchParams(window.location.search);
    const workstreamKey = activeView === 'work' ? currentParams.get('workstream') : null;
    const workstreamProject = activeView === 'work' ? currentParams.get('workProject') : null;
    const targetUrl = new URL(baseTarget, window.location.origin);
    if (workstreamKey) targetUrl.searchParams.set('workstream', workstreamKey);
    if (workstreamProject) targetUrl.searchParams.set('workProject', workstreamProject);
    const target = `${targetUrl.pathname}${targetUrl.search}`;
    const current = window.location.pathname + window.location.search;
    if (target === current) return;

    const cur = parseUrl(window.location.pathname, window.location.search);
    // Deep-link race guards: URL 이 store 가 아직 못 가진 키를 가리키면 보존.
    if (cur.sessionKey && !activeSessionId) return;
    // Preserve legacy /r links long enough for App to render retirement guidance.
    if (cur.roomKey) return;

    // Browser back/forward already moved the address bar. While the app catches
    // store state up to that URL, never push a fresh history entry — that would
    // recreate the location the user just left and make Back feel broken.
    if (handlingPopRef.current) {
      window.history.replaceState(null, '', target);
      return;
    }

    // 의미 있는 navigation (key 변경) 은 push, view-only 변경은 replace.
    const keyChanged = cur.sessionKey !== sessionKey || cur.systemTab !== systemTab;
    if (keyChanged) {
      window.history.pushState(null, '', target);
    } else {
      window.history.replaceState(null, '', target);
    }
  }, [activeSessionId, activeView, sessions, systemTabs, activeSystemTabId, enabled]);

  // URL → store (browser back/forward)
  useEffect(() => {
    const handler = () => {
      handlingPopRef.current = true;
      if (popClearTimerRef.current !== null) window.clearTimeout(popClearTimerRef.current);
      // Session/message loading can finish after this synchronous handler returns.
      // Keep the flag briefly so the following store→URL mirror canonicalizes via
      // replaceState instead of pushState.
      popClearTimerRef.current = window.setTimeout(() => {
        handlingPopRef.current = false;
        popClearTimerRef.current = null;
      }, 1500);

      const { sessionKey, roomKey, view, systemTab } = parseUrl(window.location.pathname, window.location.search);
      const sStore = useSessionStore.getState();
      const fStore = useFileStore.getState();

      const currentSessionKey = urlKeyForSession(sStore.sessions, sStore.activeSessionId);
      if (sessionKey !== currentSessionKey) {
        handlers.onPopSession(sessionKey);
      }
      if (roomKey) handlers.onPopRoom(roomKey);
      const currentSystemKind = fStore.systemTabs.find((t) => t.id === fStore.activeSystemTabId)?.kind ?? null;
      if (systemTab !== currentSystemKind) {
        if (systemTab) {
          fStore.openSystemTab(systemTab);
        } else if (fStore.activeSystemTabId) {
          fStore.activateChatSlot();
        }
      }
      const nextView: ActiveView = view ?? 'chat';
      if (nextView !== sStore.activeView) {
        sStore.setActiveView(nextView);
      }
    };
    window.addEventListener('popstate', handler);
    return () => {
      window.removeEventListener('popstate', handler);
      if (popClearTimerRef.current !== null) window.clearTimeout(popClearTimerRef.current);
    };
  }, [handlers]);
}
