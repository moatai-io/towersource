import React, { useMemo, useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { useSessionStore, type SessionMeta } from '../../stores/session-store';
import { useFileStore, type FileEntrySortMode, type FileProjectSortMode } from '../../stores/file-store';
import { type Pin } from '../../stores/pin-store';
import { usePromptStore, type PromptItem } from '../../stores/prompt-store';
import { useProjectStore, type Project } from '../../stores/project-store';
import { useSpaceStore } from '../../stores/space-store';
import { SpaceFilter } from './SpaceFilter';
import { SessionItem } from '../sessions/SessionItem';
import { SelectionToolbar } from '../files/SelectionToolbar';
import { PinList } from '../pinboard/PinList';
import { PromptItem as PromptItemComponent } from '../prompts/PromptItem';
import { toastError, toastSuccess } from '../../utils/toast';
import { useConfirm } from '../../hooks/useDialog';
import { AgentCredentialsModal } from './AgentCredentialsModal';
import { readDroppedItems, uploadDroppedFiles } from '../../utils/folder-drop';
import { notifyUploadResult } from '../../utils/upload-notice';
import { emitProductNotice } from '../../utils/product-notice';
import { getCurrentRole, getCurrentUserId, isOperatorOrAdmin } from '../../utils/auth';
import { useRoomStore } from '../../stores/room-store';
import { HistoryPanel } from '../history/HistoryPanel';
import { SessionFilesMenuSection } from './SessionFilesMenuSection';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/settings-store';
import { getSessionPresentationKind, isPureAgentSession } from '../../features/agent-sessions/classification';
import { RunIndicator } from '../common/RunIndicator';
import { deriveProjectSlugFromName, isValidProjectSlug, normalizeProjectSlugInput } from '../../utils/project-slug';
import { getLatestSessionDismissKey, isLatestSessionDismissed, loadDismissedLatestSessionKeys, saveDismissedLatestSessionKeys } from '../../utils/latest-session-persistence';
import { saveSessionListFilter, type SessionKindFilter } from '../../utils/session-list-filters';
import { rememberAgentWorkspaceLocation } from '../../features/agent-workspace/navigation-state';
import { AgentIdentityAvatar } from '../../features/agent-profile/AgentIdentityAvatar';
import { MOBILE_DOCUMENT_RECENTS_CHANGED, readMobileDocumentRecents, type MobileDocumentRecent } from '../files/mobileDocumentRecents';
import { SidebarProjectFiles } from '../../features/navigation-sidebar/project-files/SidebarProjectFiles';
import { SidebarSessionsToolbar } from '../../features/navigation-sidebar/sessions/SidebarSessionsToolbar';
import { buildSidebarSessionListModel } from '../../features/navigation-sidebar/sessions/sidebar-session-list-model';
import { buildSidebarSessionTimelineModel } from '../../features/navigation-sidebar/sessions/sidebar-session-timeline-model';
import { SidebarSessionTimeline } from '../../features/navigation-sidebar/sessions/SidebarSessionTimeline';
import { buildSidebarAgentRailModel } from '../../features/navigation-sidebar/sessions/sidebar-agent-rail-model';

const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

type MobileAgentPane = 'root' | 'detail';
type AgentNavScope = 'team' | 'work';
let lastMobileAgentNavigation: {
  pane: MobileAgentPane;
  scope: AgentNavScope;
  projectId: string | null;
} = { pane: 'root', scope: 'work', projectId: null };

// Mobile sidebar unmounts every time the drawer closes. Keep "Show all"
// expansion choices outside component-local state so returning to the AI tab
// restores the same session-list shape the user just opened.
const SESSION_SHOW_ALL_STORAGE_KEY = 'sidebar-session-show-all:v1';
const SESSION_VISIBLE_COUNT_STORAGE_KEY = 'sidebar-session-visible-count:v1';
const SIDEBAR_SCROLL_STORAGE_KEY = 'sidebar-scroll:v1';
const LATEST_SESSIONS_VISIBLE_COUNT_STORAGE_KEY = 'sidebar-latest-sessions-visible-count:v1';
const SESSION_INITIAL_EXPANDED_LIMIT = 20;
const SESSION_LOAD_BATCH = 50;
const AGENT_SESSION_PREVIEW_LIMIT_STORAGE_KEY = 'sidebar-agent-session-preview-limit:v1';
const LATEST_SESSIONS_DEFAULT_LIMIT = 50;
const LATEST_SESSIONS_LOAD_BATCH = 50;

function getAgentSessionPreviewLimit(): 20 | 50 {
  try {
    return localStorage.getItem(AGENT_SESSION_PREVIEW_LIMIT_STORAGE_KEY) === '50' ? 50 : 20;
  } catch {
    return 20;
  }
}

function saveAgentSessionPreviewLimit(limit: 20 | 50): void {
  try {
    localStorage.setItem(AGENT_SESSION_PREVIEW_LIMIT_STORAGE_KEY, String(limit));
    window.dispatchEvent(new CustomEvent('tower:agent-session-preview-limit-updated', { detail: { limit } }));
  } catch {}
}

function loadSessionShowAllKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(SESSION_SHOW_ALL_STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set();
}

function saveSessionShowAllKeys(keys: Set<string>): void {
  try {
    localStorage.setItem(SESSION_SHOW_ALL_STORAGE_KEY, JSON.stringify([...keys]));
  } catch {}
}

function loadSessionVisibleCounts(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SESSION_VISIBLE_COUNT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveSessionVisibleCounts(counts: Record<string, number>): void {
  try {
    localStorage.setItem(SESSION_VISIBLE_COUNT_STORAGE_KEY, JSON.stringify(counts));
  } catch {}
}

function getSessionStoredVisibleCount(key: string): number | null {
  const counts = loadSessionVisibleCounts();
  const count = counts[key];
  if (Number.isFinite(count) && count > 0) return count;
  // Backward-compatible migration for users who had the old boolean "show all" flag.
  return loadSessionShowAllKeys().has(key) ? SESSION_INITIAL_EXPANDED_LIMIT : null;
}

function setSessionStoredVisibleCount(key: string, count: number): void {
  const counts = loadSessionVisibleCounts();
  counts[key] = Math.max(SESSION_INITIAL_EXPANDED_LIMIT, Math.floor(count));
  saveSessionVisibleCounts(counts);

  const legacyKeys = loadSessionShowAllKeys();
  legacyKeys.add(key);
  saveSessionShowAllKeys(legacyKeys);
}

function clearSessionStoredVisibleCount(key: string): void {
  const counts = loadSessionVisibleCounts();
  delete counts[key];
  saveSessionVisibleCounts(counts);

  const legacyKeys = loadSessionShowAllKeys();
  legacyKeys.delete(key);
  saveSessionShowAllKeys(legacyKeys);
}

function loadSidebarScroll(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SIDEBAR_SCROLL_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveSidebarScroll(tab: string, scrollTop: number): void {
  const sanitized = Math.max(0, Math.floor(scrollTop));
  const current = loadSidebarScroll();
  // In React dev StrictMode, effects mount → cleanup → mount once to find side
  // effects. Mobile drawers also start at scrollTop=0 before restore runs. Do
  // not let that synthetic/initial 0 erase a real previous position.
  if (sanitized === 0 && (current[tab] ?? 0) > 0) return;
  const next = {
    ...current,
    [tab]: sanitized,
  };
  try {
    localStorage.setItem(SIDEBAR_SCROLL_STORAGE_KEY, JSON.stringify(next));
  } catch {}
}

function getStoredSidebarScroll(tab: string): number {
  const value = loadSidebarScroll()[tab];
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isSessionShowAllExpanded(key: string): boolean {
  return getSessionStoredVisibleCount(key) !== null;
}

function getInitialSessionVisibleLimit(key: string): number {
  return getSessionStoredVisibleCount(key) ?? SESSION_INITIAL_EXPANDED_LIMIT;
}

function getLatestSessionsStoredVisibleCount(): number {
  const defaultLimit = LATEST_SESSIONS_DEFAULT_LIMIT;
  try {
    const raw = localStorage.getItem(LATEST_SESSIONS_VISIBLE_COUNT_STORAGE_KEY);
    const count = raw ? Number(raw) : 0;
    if (Number.isFinite(count) && count > 0) return Math.max(defaultLimit, Math.floor(count));
  } catch {}
  return defaultLimit;
}

function setLatestSessionsStoredVisibleCount(count: number): void {
  try {
    localStorage.setItem(
      LATEST_SESSIONS_VISIBLE_COUNT_STORAGE_KEY,
      String(Math.max(LATEST_SESSIONS_DEFAULT_LIMIT, Math.floor(count))),
    );
  } catch {}
}

function getSessionDisplayCount(total: number, previewCount: number, expanded: boolean, visibleLimit: number): number {
  if (total <= 0) return 0;
  const limit = expanded ? Math.max(previewCount, visibleLimit) : previewCount;
  return Math.min(total, limit);
}

function getNextSessionVisibleLimit(total: number, previewCount: number, expanded: boolean, visibleLimit: number): number {
  if (!expanded) return Math.min(total, Math.max(previewCount, SESSION_INITIAL_EXPANDED_LIMIT));
  return Math.min(total, Math.max(previewCount, visibleLimit) + SESSION_LOAD_BATCH);
}

function getNextSessionBatchCount(total: number, previewCount: number, expanded: boolean, visibleLimit: number): number {
  const displayedCount = getSessionDisplayCount(total, previewCount, expanded, visibleLimit);
  const nextLimit = getNextSessionVisibleLimit(total, previewCount, expanded, visibleLimit);
  return Math.max(0, nextLimit - displayedCount);
}

function tsToMs(raw?: string | null): number {
  if (!raw) return 0;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
  const t = new Date(normalized).getTime();
  return Number.isFinite(t) ? t : 0;
}

function isPinnedProject(p: Project | { pinned?: boolean }): boolean {
  return !!p.pinned;
}

function pinnedOrder(p: Project | { pinOrder?: number | null }): number {
  return p.pinOrder ?? 9999;
}

function isSidebarPerfEnabled(): boolean {
  try {
    return localStorage.getItem('tower:perf:sidebar') === '1';
  } catch {
    return false;
  }
}

/* ── Highlighted snippet renderer ──
 * Backend search service wraps matches with STX (U+0002) / ETX (U+0003) control
 * chars. We split on the markers and render <mark> as React elements so there
 * is zero HTML injection surface (no dangerouslySetInnerHTML).
 * Contract defined in: packages/backend/services/search.ts
 */
const HIGHLIGHT_RE = /([^]*)/g;

function Highlighted({ text, className }: { text: string; className?: string }) {
  if (!text) return null;
  if (text.indexOf('') < 0) return <span className={className}>{text}</span>;

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  HIGHLIGHT_RE.lastIndex = 0;
  while ((m = HIGHLIGHT_RE.exec(text)) !== null) {
    if (m.index > lastIndex) parts.push(text.slice(lastIndex, m.index));
    parts.push(
      <mark
        key={key++}
        className="bg-primary-500/25 text-primary-300 rounded-sm px-0.5"
      >
        {m[1]}
      </mark>,
    );
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return <span className={className}>{parts}</span>;
}

/* ── Filter Chip ── */
function FilterChip({ active, onClick, title, children }: {
  active: boolean; onClick: () => void; title: string; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 rounded text-[12px] font-medium transition-colors ${
        active
          ? 'bg-primary-600/20 text-primary-400 ring-1 ring-primary-500/30'
          : 'text-surface-600 hover:text-gray-400 hover:bg-surface-800'
      }`}
      title={title}
    >
      {children}
    </button>
  );
}

/* ── Stats Bar — running / done / 7-day pace ── */
function StatsBar({ sessions }: { sessions: SessionMeta[] }) {
  const { t } = useTranslation('layout');
  const streamingSessions = useSessionStore((s) => s.streamingSessions);
  const unreadSessions = useSessionStore((s) => s.unreadSessions);

  const runningCount = streamingSessions.size;
  // Done = recently completed (unread) but NOT currently running
  const doneCount = React.useMemo(() => {
    let count = 0;
    unreadSessions.forEach(id => { if (!streamingSessions.has(id)) count++; });
    return count;
  }, [unreadSessions, streamingSessions]);

  // 7-day session count
  const weekCount = React.useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return sessions.filter(s => {
      const t = new Date(s.updatedAt.includes('T') ? s.updatedAt : s.updatedAt.replace(' ', 'T') + 'Z').getTime();
      return t > cutoff;
    }).length;
  }, [sessions]);

  // Nothing to show? Hide entirely
  if (runningCount === 0 && doneCount === 0 && weekCount === 0) return null;

  return (
    <div className="flex items-center gap-2.5 pb-1.5 px-0.5">
      {runningCount > 0 && (
        <span className="tone-success tone-text flex items-center gap-1 text-[12px] font-medium">
          <RunIndicator size="xs" label={t('runningSessions')} className="tone-success tone-text" />
          {t('running_count', { count: runningCount })}
        </span>
      )}
      {doneCount > 0 && (
        <span className="tone-warning tone-text flex items-center gap-1 text-[12px] font-medium">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {t('done_count', { count: doneCount })}
        </span>
      )}
      {weekCount > 0 && (
        <span className="flex items-center gap-1 text-[12px] text-surface-600">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
          </svg>
          {t('week_count', { count: weekCount })}
        </span>
      )}
    </div>
  );
}

// Session working files now live in the app hamburger menu so the navigation
// sidebar can devote its full height to teammates and conversations.

// ─────────────────────────────────────────────────────────────────────────────

/** Opens the all-teammates workspace as a compact team-formation ticket. */
function AgentTeamFormationTicket({ projects }: { projects: Project[] }) {
  const { t } = useTranslation('layout');
  const teammates = projects.filter((project) => project.systemKey !== 'ai-talent-team' && !project.archived);
  const visibleTeammates = teammates.slice(0, 3);
  const teammateCount = teammates.length;

  return (
    <div className="sidebar-team-ticket-container border-b border-surface-800/70 px-3 py-2">
      <button
        type="button"
        onClick={() => {
          const sessionStore = useSessionStore.getState();
          sessionStore.setActiveView('aiTeam');
          if (sessionStore.isMobile) sessionStore.setSidebarOpen(false);
          window.requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-ai-team-scroll]')?.scrollTo({ top: 0 }));
        }}
        className="sidebar-team-ticket group relative w-full overflow-hidden rounded-2xl border border-primary-500/25 bg-surface-900/85 px-3 py-2.5 text-left shadow-[0_4px_14px_rgba(15,23,42,0.08)] transition-[background-color,border-color,box-shadow] hover:border-primary-500/45 hover:bg-surface-900 hover:shadow-[0_8px_20px_rgba(15,23,42,0.1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/70"
        aria-label={t('openAiTeamHomeWithCount', { count: teammateCount })}
      >
        <span aria-hidden="true" className="absolute inset-y-3 left-0 w-1 rounded-r-full bg-primary-500/70" />

        <span className="sidebar-team-ticket-header relative flex min-w-0 items-center justify-between gap-2 pl-1">
          <span className="sidebar-team-ticket-kicker min-w-0 truncate whitespace-nowrap text-[9px] font-extrabold uppercase tracking-[0.18em] text-primary-700 dark:text-primary-300">{t('teamWorkspace')}</span>
          <span className="sidebar-team-ticket-count shrink-0 whitespace-nowrap rounded-full border border-primary-500/20 bg-primary-500/10 px-2 py-0.5 text-[9px] font-bold tabular-nums text-primary-800 dark:text-primary-200">
            {t('teammateCountCompact', { count: teammateCount })}
          </span>
        </span>

        <span className="sidebar-team-ticket-body relative mt-3 grid min-w-0 grid-cols-[76px_minmax(0,1fr)_auto] items-center gap-3.5 pl-1">
          <span className="sidebar-team-ticket-avatars flex h-8 w-[76px] min-w-0 items-center gap-1.5" aria-hidden="true">
            {visibleTeammates.map((project) => (
              <span
                key={project.id}
                className="sidebar-team-ticket-avatar grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-full bg-surface-800 ring-1 ring-surface-700/70"
              >
                <AgentIdentityAvatar project={project} showListAccent={false} className="h-6 w-6" />
              </span>
            ))}
            {visibleTeammates.length === 0 && (
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-dashed border-primary-500/40 bg-primary-500/10 text-sm font-light text-primary-800 dark:text-primary-200">+</span>
            )}
          </span>

          <span className="sidebar-team-ticket-copy min-w-0">
            <span className="sidebar-team-ticket-title block truncate whitespace-nowrap text-[14px] font-extrabold leading-5 tracking-[-0.01em] text-surface-100">{t('aiTeamHome')}</span>
            <span className="sidebar-team-ticket-description mt-1 block truncate whitespace-nowrap text-[10.5px] leading-4 text-surface-500">{t('rolesToolsPermissionsTogether')}</span>
          </span>

          <span className="sidebar-team-ticket-cta flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-primary-500/25 bg-primary-500/10 px-2 py-1 text-[10px] font-bold text-primary-800 transition-colors group-hover:bg-primary-500/15 dark:text-primary-200">
            <span className="sidebar-team-ticket-cta-label">{t('buildTeam')}</span><span className="text-sm leading-none">›</span>
          </span>
        </span>
      </button>
    </div>
  );
}

interface SidebarProps {
  // label: when provided, new session is auto-tagged into that deck (label group)
  onNewSession: (projectId?: string, label?: string) => void;
  onSelectSession: (session: SessionMeta) => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
  onToggleFavorite: (id: string, favorite: boolean) => void;
  onFileClick: (path: string) => void;
  onPersonalFileClick?: (uri: string) => void;
  onPersonalTodosClick?: () => void;
  onDirectoryClick: (path: string) => void;
  onRequestFileTree: (path?: string) => void;
  onPinFile?: (path: string) => void;
  onUnpinFile?: (id: number) => void;
  onPinClick?: (pin: Pin) => void;
  onSettingsClick?: () => void;
  onPromptClick?: (prompt: PromptItem) => void;
  onPromptEdit?: (prompt: PromptItem) => void;
  onPromptDelete?: (id: number | string) => void;
  onPromptAdd?: () => void;
  onPromptInsert?: (prompt: PromptItem) => void;
  onNewSessionInFolder?: (path: string) => void;
  onCollapseSidebar?: () => void;
}

export function Sidebar({
  onNewSession, onSelectSession, onDeleteSession,
  onRenameSession, onToggleFavorite,
  onFileClick, onPersonalFileClick, onPersonalTodosClick, onDirectoryClick, onRequestFileTree,
  onPinFile, onUnpinFile, onPinClick, onSettingsClick,
  onPromptClick, onPromptEdit, onPromptDelete, onPromptAdd,
  onNewSessionInFolder, onCollapseSidebar,
}: SidebarProps) {
  const { t, i18n } = useTranslation('layout');
  const serverVersion = useSettingsStore((s) => s.serverConfig?.version);
  const agentFirstEnabled = useSettingsStore((s) => s.serverConfig?.agentFirstEnabled === true);
  const capabilityProjectId = useSettingsStore((s) => s.capabilityProjectId);
  const sessions = useSessionStore((s) => s.sessions);
  const hydrateProjectSessions = useSessionStore((s) => s.hydrateProjectSessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const isMobile = useSessionStore((s) => s.isMobile);
  const activeSessionCwd = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions.find((ss) => ss.id === id)?.cwd ?? '' : '';
  });
  const sidebarTab = useSessionStore((s) => s.sidebarTab);
  const setSidebarTab = useSessionStore((s) => s.setSidebarTab);
  const searchQuery = useSessionStore((s) => s.searchQuery);
  const setSearchQuery = useSessionStore((s) => s.setSearchQuery);
  // Filter chip states (persisted to localStorage)
  const [filterLabels, setFilterLabels] = useState(() => localStorage.getItem('sidebar-filter-labels') === 'true');
  const [filterMy, setFilterMy] = useState(() => localStorage.getItem('sidebar-filter-my') === 'true');
  const [filterFav, setFilterFav] = useState(() => localStorage.getItem('sidebar-filter-fav') === 'true');
  const [filterDone, setFilterDone] = useState(() => localStorage.getItem('sidebar-filter-done') === 'true');
  const [sessionKindFilter, setSessionKindFilter] = useState<SessionKindFilter>(() => {
    const stored = localStorage.getItem('sidebar-session-kind-filter');
    return stored === 'all' || stored === 'agents' || stored === 'runs' || stored === 'external' ? stored : 'chats';
  });
  const [filterOpen, setFilterOpen] = useState(false);
  // Archived toggle — when true, search also matches sessions that live in
  // History (soft-deleted / archived). Persisted to localStorage so the user's
  // choice survives a reload. Default false — history is a low-signal corner.
  const [includeArchived, setIncludeArchived] = useState(() => localStorage.getItem('sidebar-search-archived') === 'true');
  const unreadSessions = useSessionStore((s) => s.unreadSessions);
  const streamingSessions = useSessionStore((s) => s.streamingSessions);
  const activeFilterLabels = useMemo(() => {
    const labels: string[] = [];
    if (filterMy) labels.push(t('mySessions'));
    if (filterFav) labels.push(t('favorites'));
    if (filterDone) labels.push(t('done'));
    if (filterLabels) labels.push(t('decks'));
    if (sessionKindFilter === 'agents') labels.push('Subagents');
    if (sessionKindFilter === 'runs') labels.push('Runs');
    if (sessionKindFilter === 'external') labels.push(t('externalDeployment'));
    if (sessionKindFilter === 'all') labels.push('All');
    return labels;
  }, [filterMy, filterFav, filterDone, filterLabels, sessionKindFilter, t]);

  useEffect(() => {
    const start = (event: Event) => {
      const projectId = (event as CustomEvent<{ projectId?: string }>).detail?.projectId;
      if (agentFirstEnabled && projectId) onNewSession(projectId);
    };
    window.addEventListener('tower-new-project-conversation', start);
    return () => window.removeEventListener('tower-new-project-conversation', start);
  }, [agentFirstEnabled, onNewSession]);

  const setKindFilter = (next: SessionKindFilter) => {
    setSessionKindFilter(next);
    saveSessionListFilter('kind', next);
  };

  const toggleFilter = (key: 'my' | 'fav' | 'done' | 'labels', value: boolean, setter: (v: boolean) => void) => {
    const next = !value;
    setter(next);
    if (key === 'labels') {
      localStorage.setItem('sidebar-filter-labels', String(next));
    } else {
      saveSessionListFilter(key === 'fav' ? 'favorites' : key, next);
    }
  };

  const [ungroupedCollapsed, setUngroupedCollapsed] = useState(false);
  const ungroupedShowAllKey = 'ungrouped::__ungrouped__';
  const [ungroupedExpanded, setUngroupedExpanded] = useState(() => isSessionShowAllExpanded(ungroupedShowAllKey));
  const [ungroupedVisibleLimit, setUngroupedVisibleLimit] = useState(() => getInitialSessionVisibleLimit(ungroupedShowAllKey));
  const toggleUngroupedExpanded = useCallback((total: number, previewCount: number) => {
    setUngroupedExpanded((prev) => {
      if (prev) {
        clearSessionStoredVisibleCount(ungroupedShowAllKey);
        setUngroupedVisibleLimit(SESSION_INITIAL_EXPANDED_LIMIT);
        return false;
      }
      const nextLimit = getNextSessionVisibleLimit(total, previewCount, false, ungroupedVisibleLimit);
      setSessionStoredVisibleCount(ungroupedShowAllKey, nextLimit);
      setUngroupedVisibleLimit(nextLimit);
      return true;
    });
  }, [ungroupedVisibleLimit]);
  const showMoreUngroupedSessions = useCallback((total: number, previewCount: number) => {
    setUngroupedExpanded(true);
    setUngroupedVisibleLimit((prev) => {
      const next = getNextSessionVisibleLimit(total, previewCount, ungroupedExpanded, prev);
      setSessionStoredVisibleCount(ungroupedShowAllKey, next);
      return next;
    });
  }, [ungroupedExpanded]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // ─── Per-tab scroll position preservation ───
  //
  // The sidebar uses a single scrollable container that swaps inner content
  // based on `sidebarTab`. On mobile the whole sidebar drawer unmounts when the
  // user selects a session, so in-memory Zustand state is not enough: persist a
  // tiny per-tab scroll snapshot to localStorage and restore it on remount.
  const prevSidebarTabRef = useRef<string>(sidebarTab);
  const restoredSidebarTabRef = useRef<string | null>(null);
  const saveSidebarTabScroll = useCallback((tab: string, scrollTop: number) => {
    useFileStore.getState().setSidebarScroll(tab, scrollTop);
    saveSidebarScroll(tab, scrollTop);
  }, []);
  const restoreSidebarTabScroll = useCallback((tab: string, options?: { onlyIfAtTop?: boolean }) => {
    const c = scrollContainerRef.current;
    if (!c) return false;
    const memoryTarget = useFileStore.getState().sidebarScroll[tab];
    const storedTarget = getStoredSidebarScroll(tab);
    const target = Number.isFinite(memoryTarget) && memoryTarget > 0 ? memoryTarget : storedTarget;
    if (target <= 0) return false;
    if (options?.onlyIfAtTop && c.scrollTop > 2) return false;
    c.scrollTop = target;
    if (c.scrollTop > 0) {
      restoredSidebarTabRef.current = tab;
      return true;
    }
    return false;
  }, []);
  useLayoutEffect(() => {
    const prevTab = prevSidebarTabRef.current;
    const container = scrollContainerRef.current;
    if (!container) {
      prevSidebarTabRef.current = sidebarTab;
      return;
    }
    // Save the leaving tab's scroll position.
    if (prevTab !== sidebarTab) {
      saveSidebarTabScroll(prevTab, container.scrollTop);
    }
    // Restore the new tab's scroll. Multiple passes cover cached content,
    // lazily rendered project/file sections, and mobile drawer mount animation.
    restoredSidebarTabRef.current = null;
    const restore = () => {
      restoreSidebarTabScroll(sidebarTab);
    };
    restore();
    const raf = window.requestAnimationFrame(restore);
    const t1 = window.setTimeout(restore, 80);
    const t2 = window.setTimeout(restore, 240);
    prevSidebarTabRef.current = sidebarTab;
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [sidebarTab, saveSidebarTabScroll, restoreSidebarTabScroll]);

  // Continuously track scroll within the active tab so even if the user never
  // switches tabs, refreshes, or the mobile drawer unmounts later, we have a
  // recent value. The cleanup saves one final synchronous snapshot.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        saveSidebarTabScroll(sidebarTab, container.scrollTop);
      });
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (raf) window.cancelAnimationFrame(raf);
      if (container.scrollTop > 0) saveSidebarTabScroll(sidebarTab, container.scrollTop);
    };
  }, [sidebarTab, saveSidebarTabScroll]);

  const tree = useFileStore((s) => s.tree);
  const treeRoot = useFileStore((s) => s.treeRoot);

  const prompts = usePromptStore((s) => s.prompts);

  // pgEnabled / unreadCounts moved to Header NavTabs

  const currentUsername = useMemo(() => localStorage.getItem('username') || undefined, []);

  const [fileTreeDragOver, setFileTreeDragOver] = useState(false);
  const [folderProjectQuery, setFolderProjectQuery] = useState('');
  const [mobileProjectPickerOpen, setMobileProjectPickerOpen] = useState(false);
  const [mobileProjectQuery, setMobileProjectQuery] = useState('');
  const [personalFilesOpen, setPersonalFilesOpen] = useState(false);
  const [mobileDocumentRecents, setMobileDocumentRecents] = useState<MobileDocumentRecent[]>(readMobileDocumentRecents);
  const [mobileQuickFilesView, setMobileQuickFilesView] = useState<'recent' | 'session' | null>(null);
  const [personalFiles, setPersonalFiles] = useState<Array<{ id: string; uri: string; relativePath: string; name: string; updatedAt: string }>>([]);
  const [personalFilesLoading, setPersonalFilesLoading] = useState(false);
  const [personalFilesError, setPersonalFilesError] = useState('');
  const [personalFileMenu, setPersonalFileMenu] = useState<{ x: number; y: number; file: { id: string; uri: string; relativePath: string; name: string; updatedAt: string } } | null>(null);
  const [personalRenameFile, setPersonalRenameFile] = useState<{ id: string; uri: string; relativePath: string; name: string; updatedAt: string } | null>(null);
  const [personalRenameValue, setPersonalRenameValue] = useState('');
  const confirmPersonalFileAction = useConfirm();
  const fileTreeDragCounter = useRef(0);

  const [sharedWithMe, setSharedWithMe] = useState<{ id: string; file_path: string; owner_username: string }[]>([]);
  const [searchResults, setSearchResults] = useState<{ type: string; sessionId: string; sessionShortCode?: string; sessionName: string; projectName?: string | null; snippet: string; nameSnippet?: string; rank?: number; archived?: boolean; memoryTitle?: string; memoryOutcome?: string; memoryNextActions?: string[]; memoryCautions?: string[] }[] | null>(null);

  // Clear search helper — clears both query and results in one shot
  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setSearchResults(null);
  }, [setSearchQuery]);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;
    fetch('/api/shares/with-me', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setSharedWithMe(data); })
      .catch(() => {});
  }, []);

  // Debounced server-side tsvector search
  // Pass includeArchived (History toggle) and the current session's projectId
  // so backend ranker can boost hits in the project the user is working in.
  useEffect(() => {
    if (!searchQuery.trim() || searchQuery.length < 2) {
      setSearchResults(null);
      return;
    }
    const timer = setTimeout(async () => {
      const tk = localStorage.getItem('token');
      const hdrs: Record<string, string> = {};
      if (tk) hdrs['Authorization'] = `Bearer ${tk}`;
      try {
        const params = new URLSearchParams({
          q: searchQuery,
          memoryLimit: '5',
          sessionLimit: '8',
          messageLimit: '10',
        });
        if (includeArchived) params.set('includeArchived', '1');
        const curProj = useSessionStore.getState().sessions.find(
          (s) => s.id === useSessionStore.getState().activeSessionId,
        )?.projectId;
        if (curProj) params.set('projectId', curProj);
        const res = await fetch(`/api/search?${params.toString()}`, { headers: hdrs });
        if (res.ok) setSearchResults(await res.json());
      } catch {}
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, includeArchived]);

  const handleFileTreeDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    fileTreeDragCounter.current = 0;
    setFileTreeDragOver(false);
    if (e.dataTransfer.getData('application/x-attachment')) return;

    // Fallback: use active session cwd or request tree root if treeRoot is empty.
    // Keep this on the scalar activeSessionCwd selector so drop handling does
    // not need to search the full sessions[] list on the hot path.
    const uploadDir = treeRoot || activeSessionCwd || '';
    if (!uploadDir) {
      toastError('Upload target not ready. Open the Files tab first, then try again.');
      return;
    }

    let items;
    try {
      items = await readDroppedItems(e.dataTransfer);
    } catch (err) {
      console.error('[sidebar] Failed to read dropped items:', err);
      toastError('Failed to read dropped folder');
      return;
    }
    if (items.length === 0) return;

    try {
      const { ok, fail } = await uploadDroppedFiles(uploadDir, items);
      notifyUploadResult({ ok, fail });
      onRequestFileTree();
    } catch (err) {
      console.error('[sidebar] File upload error:', err);
      emitProductNotice({ code: 'sidebar.upload.failed', technicalDetail: err });
    }
  };

  const loadPersonalFiles = useCallback(async () => {
    setPersonalFilesLoading(true);
    setPersonalFilesError('');
    try {
      const token = localStorage.getItem('token');
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch('/api/personal-space/files', { headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('personalFilesLoadFailedWithStatus', { status: res.status }));
      setPersonalFiles(Array.isArray(data.files) ? data.files : []);
    } catch (error) {
      setPersonalFilesError(error instanceof Error ? error.message : t('personalFilesLoadFailed'));
    } finally {
      setPersonalFilesLoading(false);
    }
  }, []);

  const togglePersonalFiles = useCallback(() => {
    setPersonalFilesOpen((open) => {
      if (!open) void loadPersonalFiles();
      return !open;
    });
  }, [loadPersonalFiles]);

  const renamePersonalSidebarFile = useCallback(async () => {
    if (!personalRenameFile) return;
    const trimmed = personalRenameValue.trim().replace(/[\\/:*?"<>|]/g, '-');
    if (!trimmed) return;
    const parent = personalRenameFile.relativePath.includes('/')
      ? personalRenameFile.relativePath.slice(0, personalRenameFile.relativePath.lastIndexOf('/') + 1)
      : '';
    const nextName = trimmed.toLowerCase().endsWith('.md') ? trimmed : `${trimmed}.md`;
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const res = await fetch('/api/personal-space/files/rename', {
        method: 'POST', headers, body: JSON.stringify({ uri: personalRenameFile.uri, nextPath: `${parent}${nextName}` }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('personalFileRenameFailedWithStatus', { status: res.status }));
      setPersonalRenameFile(null);
      toastSuccess(t('personalFileRenamed'));
      await loadPersonalFiles();
    } catch (error) {
      emitProductNotice({ code: 'sidebar.personal.rename.failed', technicalDetail: error });
    }
  }, [loadPersonalFiles, personalRenameFile, personalRenameValue]);

  const archivePersonalSidebarFile = useCallback(async (file: { uri: string; name: string }) => {
    const ok = await confirmPersonalFileAction({
      title: t('archivePersonalFileTitle'),
      message: t('confirmArchivePersonalFile', { name: file.name }),
      confirmLabel: t('common:archive'),
      danger: true,
    });
    if (!ok) return;
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const res = await fetch('/api/personal-space/files/archive', { method: 'POST', headers, body: JSON.stringify({ uri: file.uri }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('archiveFailedWithStatus', { status: res.status }));
      setPersonalFileMenu(null);
      toastSuccess(t('personalFileArchived'));
      await loadPersonalFiles();
    } catch (error) {
      emitProductNotice({ code: 'sidebar.personal.archive.failed', technicalDetail: error });
    }
  }, [confirmPersonalFileAction, loadPersonalFiles]);

  useEffect(() => {
    // Only request from server when tree is empty (skip if already loaded)
    if (sidebarTab === 'files' && tree.length === 0) {
      onRequestFileTree();
    }
  }, [sidebarTab]);

  // cwd-related display removed (CWD picker moved out of sidebar)

  const allProjects = useProjectStore((s) => s.projects);
  const [agentNavScope, setAgentNavScope] = useState<AgentNavScope>(() => lastMobileAgentNavigation.scope);
  const [mobileAgentPane, setMobileAgentPane] = useState<MobileAgentPane>(() => lastMobileAgentNavigation.pane);
  const [teamRecentWorkstreams, setTeamRecentWorkstreams] = useState<Array<{ id: string; workstreamKey: string; title: string; status: string; lastAt: string; todoLeft: number; projectId: string | null; projectName: string }>>([]);
  const [teamRecentWorkstreamsLoading, setTeamRecentWorkstreamsLoading] = useState(false);
  const [selectedAgentProjectId, setSelectedAgentProjectId] = useState<string | null>(() => lastMobileAgentNavigation.projectId);
  const [agentRailMenu, setAgentRailMenu] = useState<{ x: number; y: number; projectId: string } | null>(null);
  const [agentRailRename, setAgentRailRename] = useState<{ project: Project; value: string } | null>(null);
  const [agentNavExpanded, setAgentNavExpanded] = useState(() => {
    try { return localStorage.getItem('sidebar-agent-nav-expanded:v1') === 'true'; } catch { return false; }
  });

  useEffect(() => {
    const handler = (event: Event) => {
      const sessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (!sessionId) return;
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) return;

      setSidebarTab('sessions');
      setSearchQuery('');

      const presentationKind = getSessionPresentationKind(session);
      const nextKind: SessionKindFilter = presentationKind === 'agent'
        ? 'agents'
        : presentationKind === 'run'
          ? 'runs'
          : presentationKind === 'deployment'
            ? 'all'
            : 'chats';
      setSessionKindFilter(nextKind);
      saveSessionListFilter('kind', nextKind);

      if (filterMy) {
        setFilterMy(false);
        saveSessionListFilter('my', false);
      }
      if (filterFav) {
        setFilterFav(false);
        saveSessionListFilter('favorites', false);
      }
      if (filterDone) {
        setFilterDone(false);
        saveSessionListFilter('done', false);
      }

      if (agentFirstEnabled) {
        setAgentNavScope('work');
        setSelectedAgentProjectId(session.projectId || null);
        setMobileAgentPane('detail');
      }
    };
    window.addEventListener('tower-reveal-session-in-sidebar', handler as EventListener);
    return () => window.removeEventListener('tower-reveal-session-in-sidebar', handler as EventListener);
  }, [agentFirstEnabled, filterDone, filterFav, filterMy, sessions, setSearchQuery, setSidebarTab]);

  const toggleAgentNavExpanded = useCallback(() => {
    setAgentNavExpanded((expanded) => {
      const next = !expanded;
      try { localStorage.setItem('sidebar-agent-nav-expanded:v1', String(next)); } catch {}
      return next;
    });
  }, []);

  useEffect(() => {
    lastMobileAgentNavigation = {
      pane: mobileAgentPane,
      scope: agentNavScope,
      projectId: selectedAgentProjectId,
    };
  }, [agentNavScope, mobileAgentPane, selectedAgentProjectId]);

  useEffect(() => {
    if (agentNavScope !== 'team' || selectedAgentProjectId) return;
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const params = new URLSearchParams({ rangeHours: String(24 * 30), bucketHours: '24', limit: '12' });
    let cancelled = false;
    setTeamRecentWorkstreamsLoading(true);
    void fetch(`/api/work/challenge-timeline?${params.toString()}`, { headers })
      .then(async (response) => response.ok ? response.json() : { projects: [] })
      .then((data) => {
        if (cancelled) return;
        const workstreams = (Array.isArray(data.projects) ? data.projects : []).flatMap((project: any) =>
          (Array.isArray(project.challenges) ? project.challenges : []).map((workstream: any) => ({
            id: String(workstream.id || workstream.title),
            workstreamKey: String(workstream.workstreamKey || workstream.id || workstream.title),
            title: String(workstream.title || t('untitledWork')),
            status: String(workstream.status || 'active'),
            lastAt: String(workstream.lastAt || ''),
            todoLeft: Number(workstream.todoLeft || 0),
            projectId: project.id ? String(project.id) : null,
            projectName: String(project.name || t('sharedWork')),
          })),
        ).sort((a: any, b: any) => tsToMs(b.lastAt) - tsToMs(a.lastAt)).slice(0, 10);
        setTeamRecentWorkstreams(workstreams);
      })
      .catch(() => { if (!cancelled) setTeamRecentWorkstreams([]); })
      .finally(() => { if (!cancelled) setTeamRecentWorkstreamsLoading(false); });
    return () => { cancelled = true; };
  }, [agentNavScope, selectedAgentProjectId]);
  // collapsedProjects stores exceptions from the default:
  // pinned projects are open by default, non-pinned projects are collapsed by default.
  const collapsedProjects = useProjectStore((s) => s.collapsedProjects);
  const toggleProjectCollapsed = useProjectStore((s) => s.toggleProjectCollapsed);
  const collapsedLabels = useProjectStore((s) => s.collapsedLabels);
  const toggleLabelCollapsed = useProjectStore((s) => s.toggleLabelCollapsed);
  const activeSpaceId = useSpaceStore((s) => s.activeSpaceId);

  // Filter projects by active space (for sidebar grouping)
  const projects = useMemo(() => {
    if (activeSpaceId === null) return allProjects;
    return allProjects.filter(p => p.spaceId === activeSpaceId);
  }, [allProjects, activeSpaceId]);

  // All projects — for "Move to project" context menu (no space filter)
  const allProjectsForMove = allProjects;

  const [latestSessionsVisibleLimit, setLatestSessionsVisibleLimit] = useState(() => getLatestSessionsStoredVisibleCount());
  const showMoreLatestSessions = useCallback((total: number) => {
    setLatestSessionsVisibleLimit((prev) => {
      const next = Math.min(total, Math.max(LATEST_SESSIONS_DEFAULT_LIMIT, prev) + LATEST_SESSIONS_LOAD_BATCH);
      setLatestSessionsStoredVisibleCount(next);
      return next;
    });
  }, []);

  const isLatestCandidate = useCallback((session: SessionMeta) => {
    if (!currentUsername) return true;
    const lastUserUsername = (session as SessionMeta & { lastUserUsername?: string | null }).lastUserUsername;
    return (lastUserUsername || session.ownerUsername) === currentUsername;
  }, [currentUsername]);

  const [dismissedLatestSessionKeys, setDismissedLatestSessionKeys] = useState<Set<string>>(() => loadDismissedLatestSessionKeys());

  useEffect(() => {
    void useSessionStore.getState().hydrateLatestAttentionFromServer();
  }, []);

  useEffect(() => {
    const handleDismissedKeysUpdated = (event: Event) => {
      const keys = (event as CustomEvent<{ keys?: string[] }>).detail?.keys;
      if (Array.isArray(keys)) setDismissedLatestSessionKeys(new Set(keys));
    };
    window.addEventListener('tower:latest-dismissed-keys-updated', handleDismissedKeysUpdated);
    return () => window.removeEventListener('tower:latest-dismissed-keys-updated', handleDismissedKeysUpdated);
  }, []);

  const dismissLatestSession = useCallback((sessionId: string) => {
    const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
    setDismissedLatestSessionKeys((prev) => {
      const key = session ? getLatestSessionDismissKey(session) : sessionId;
      if (prev.has(key)) return prev;
      const next = new Set(loadDismissedLatestSessionKeys());
      prev.forEach((value) => next.add(value));
      next.add(key);
      saveDismissedLatestSessionKeys(next);
      return next;
    });
    useSessionStore.getState().markSessionRead(sessionId);
  }, []);

  // Sidebar top quick view: the user's actually most recently active sessions.
  // It follows the explicit Chats/Subagents/Runs/All identity filter, but ignores unread
  // and streaming state. Agent reports inside a normal parent Chat do not change
  // that parent's identity; Task automation sessions remain Runs rather than Chats.
  // Dismissing removes only the current (sessionId, updatedAt) duplicate; the next
  // message bumps updatedAt and makes the session eligible again.
  const latestQuickSessions = useMemo(() => {
    return sessions
      .filter((s) => {
        if (!isLatestCandidate(s) || isLatestSessionDismissed(dismissedLatestSessionKeys, s)) return false;
        if (selectedAgentProjectId && s.projectId !== selectedAgentProjectId) return false;
        const presentationKind = getSessionPresentationKind(s);
        if (sessionKindFilter === 'agents') return presentationKind === 'agent';
        if (sessionKindFilter === 'runs') return presentationKind === 'run';
        if (sessionKindFilter === 'external') return presentationKind === 'deployment';
        if (sessionKindFilter === 'chats') return presentationKind === 'chat';
        return sessionKindFilter === 'all';
      })
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [sessions, isLatestCandidate, dismissedLatestSessionKeys, sessionKindFilter, selectedAgentProjectId]);

  const { filteredSessions, groupedSessions, isSearching } = useMemo(() => buildSidebarSessionListModel({
    sessions, projects, searchResults, searchQuery, kind: sessionKindFilter, filterMy, filterFav, filterDone, currentUsername,
    unreadSessionIds: unreadSessions, streamingSessionIds: useSessionStore.getState().streamingSessions,
  }), [sessions, projects, searchResults, searchQuery, sessionKindFilter, filterMy, filterFav, filterDone, currentUsername, unreadSessions]);

  const filteredSessionCountByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of filteredSessions) {
      if (!session.projectId) continue;
      counts.set(session.projectId, (counts.get(session.projectId) || 0) + 1);
    }
    return counts;
  }, [filteredSessions]);

  // Keep first-level teammate navigation independent from conversation filters.
  // Filters reshape only the right pane; they must not hide teammates or running
  // state. Personal pins remain the explicit ordering override: pinned Agents stay
  // at the top in the user's saved order, then unpinned Agents follow activity.
  const agentRailProjects = useMemo(
    () => buildSidebarAgentRailModel({ projects, sessions }),
    [projects, sessions],
  );

  const navigationGroupedSessions = useMemo(() => {
    if (!groupedSessions || !selectedAgentProjectId) return groupedSessions;
    return {
      groups: groupedSessions.groups.filter(({ project }) => project.id === selectedAgentProjectId),
      ungrouped: [],
    };
  }, [groupedSessions, selectedAgentProjectId]);

  useEffect(() => {
    if (selectedAgentProjectId && !projects.some((project) => project.id === selectedAgentProjectId)) {
      setSelectedAgentProjectId(null);
    }
  }, [projects, selectedAgentProjectId]);

  useEffect(() => {
    if (!selectedAgentProjectId) return;
    void hydrateProjectSessions(selectedAgentProjectId);
  }, [hydrateProjectSessions, selectedAgentProjectId]);

  // Projects sorted for the Files tab. Default = pinned first, then recent activity.
  const fileProjectSortMode = useFileStore((s) => s.projectSortMode);
  const projectsSortedForFiles = useMemo(() => {
    const activityRank = new Map<string, number>();
    groupedSessions?.groups.forEach((g, i) => activityRank.set(g.project.id, i));
    const projectActivityMs = (p: Project) => {
      const rank = activityRank.get(p.id);
      if (rank !== undefined) return 10_000_000_000 - rank;
      return tsToMs(p.createdAt);
    };

    // Files is an ownership/access view, not a Space-filtered conversation view.
    // Always show every project returned by the membership-scoped projects API.
    return [...allProjects].sort((a, b) => {
      if (fileProjectSortMode === 'pinned-recent') {
        const pinDelta = Number(isPinnedProject(b)) - Number(isPinnedProject(a));
        if (pinDelta !== 0) return pinDelta;
        if (isPinnedProject(a) && isPinnedProject(b)) {
          const orderDelta = pinnedOrder(a) - pinnedOrder(b);
          if (orderDelta !== 0) return orderDelta;
        }
      }
      if (fileProjectSortMode === 'name') return naturalCollator.compare(a.name, b.name);
      if (fileProjectSortMode === 'created') return tsToMs(b.createdAt) - tsToMs(a.createdAt) || naturalCollator.compare(a.name, b.name);
      return projectActivityMs(b) - projectActivityMs(a) || naturalCollator.compare(a.name, b.name);
    });
  }, [allProjects, groupedSessions, fileProjectSortMode]);
  // MobileTabBar seeds capabilityProjectId from the active session on entry.
  // After that, an explicit project-picker choice must win; otherwise the active
  // session immediately snaps Files back to its own project.
  const activeFileProjectId = capabilityProjectId || sessions.find((session) => session.id === activeSessionId)?.projectId;
  const activeFileProject = projectsSortedForFiles.find((project) => project.id === activeFileProjectId && !project.archived) || null;
  const folderProjects = useMemo(() => {
    const query = folderProjectQuery.trim().toLocaleLowerCase();
    return projectsSortedForFiles.filter((project) => {
      if (!project.rootPath || project.archived) return false;
      if (!query) return true;
      return `${project.agent?.displayName || ''} ${project.name}`.toLocaleLowerCase().includes(query);
    });
  }, [folderProjectQuery, projectsSortedForFiles]);

  useEffect(() => {
    if (!isMobile) return;
    const refresh = () => setMobileDocumentRecents(readMobileDocumentRecents());
    window.addEventListener(MOBILE_DOCUMENT_RECENTS_CHANGED, refresh);
    return () => window.removeEventListener(MOBILE_DOCUMENT_RECENTS_CHANGED, refresh);
  }, [isMobile]);

  useEffect(() => {
    if (sidebarTab !== 'files' || !activeFileProject) return;
    const fileStore = useFileStore.getState();
    // Folder navigation always opens with the selected project's root visible.
    // Previously opened child folders are restored separately through expandedPaths.
    if (!fileStore.expandedProjects.has(activeFileProject.id)) fileStore.toggleProjectExpanded(activeFileProject.id);
  }, [activeFileProject, sidebarTab]);

  const sessionListShapeKey = sidebarTab === 'sessions'
    ? `${filteredSessions.length}:${groupedSessions?.groups.length ?? 0}:${groupedSessions?.ungrouped.length ?? 0}:${isSearching ? 'search' : 'normal'}`
    : sidebarTab;
  useLayoutEffect(() => {
    if (sidebarTab !== 'sessions') return;
    // Session groups can be empty on the first mobile drawer paint and fill in
    // right after store/project hydration. Restore once more after that shape
    // changes, but only while the list is still effectively at the top so we do
    // not fight intentional user scrolling.
    const restore = () => restoreSidebarTabScroll('sessions', { onlyIfAtTop: true });
    restore();
    const raf = window.requestAnimationFrame(restore);
    const t1 = window.setTimeout(restore, 120);
    const t2 = window.setTimeout(restore, 360);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [sidebarTab, sessionListShapeKey, restoreSidebarTabScroll]);

  const sidebarRenderPerfRef = useRef({ count: 0, since: 0 });
  sidebarRenderPerfRef.current.count += 1;
  useEffect(() => {
    if (!isSidebarPerfEnabled()) return;
    const now = performance.now();
    const ref = sidebarRenderPerfRef.current;
    if (ref.since === 0) ref.since = now;
    const elapsed = now - ref.since;
    if (elapsed < 1000) return;

    console.info(
      `[perf][Sidebar] renders=${ref.count} elapsedMs=${Math.round(elapsed)} tab=${sidebarTab} sessions=${sessions.length} filtered=${filteredSessions.length} grouped=${groupedSessions?.groups.length ?? 0}`,
    );
    ref.count = 0;
    ref.since = now;
  });

  const handleMoveSession = async (sessionId: string, projectId: string | null) => {
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/move`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ projectId }),
      });
      if (res.ok) {
        useSessionStore.getState().updateSessionMeta(sessionId, { projectId });
      } else {
        const data = await res.json().catch(() => ({}));
        emitProductNotice({ code: 'sidebar.session.move.failed', technicalDetail: data.error, context: { status: res.status } });
      }
    } catch {
      toastError('Failed to move session');
    }
  };

  const mobileSelectedAgent = selectedAgentProjectId ? agentRailProjects.find(({ project }) => project.id === selectedAgentProjectId)?.project ?? null : null;
  const mobileAgentNavigation = agentFirstEnabled && !isSearching ? mobileAgentPane === 'root' ? (
    <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-2 min-[769px]:hidden" aria-label={t('agentNavigation')} data-mobile-agent-pane="root">
      <div className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-surface-600">{t('mobileNavigationTitle')}</div>
      <div className="space-y-1">
        <button type="button" onClick={() => { setSelectedAgentProjectId(null); setAgentNavScope('work'); setMobileAgentPane('detail'); useFileStore.getState().activateChatSlot(); useSessionStore.getState().setActiveView('chat'); }} className="flex min-h-14 w-full items-center gap-3 rounded-xl px-3 text-left text-surface-200 hover:bg-surface-800/70">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary-500/10 text-primary-300"><svg className="h-4.5 w-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M12 7.25V12l3 1.75M4.75 8.5H2.5V6.25M3.2 8.1A9 9 0 1 1 3 15.5" /></svg></span>
          <span className="min-w-0 flex-1"><span className="block text-[14px] font-semibold">{t('workNav')}</span><span className="mt-0.5 block text-[11px] text-surface-600">{t('mobileNewDescription')}</span></span><span className="text-surface-600" aria-hidden="true">›</span>
        </button>
        <button type="button" onClick={() => { setSelectedAgentProjectId(null); setAgentNavScope('team'); setMobileAgentPane('detail'); useSessionStore.getState().setActiveView('aiTeam'); window.requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-ai-team-scroll]')?.scrollTo({ top: 0 })); }} className="flex min-h-14 w-full items-center gap-3 rounded-xl px-3 text-left text-surface-200 hover:bg-surface-800/70">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-surface-800 text-surface-400"><svg className="h-4.5 w-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M4 19.5V8.25L12 3l8 5.25V19.5M8 19.5v-5h8v5" /></svg></span>
          <span className="min-w-0 flex-1"><span className="block text-[14px] font-semibold">{t('aiTeamNav')}</span><span className="mt-0.5 block text-[11px] text-surface-600">{t('mobileHomeDescription')}</span></span><span className="text-surface-600" aria-hidden="true">›</span>
        </button>
      </div>
      <div className="mx-1 mt-3 border-t border-surface-800 pt-3"><div className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-surface-600">{t('chooseAiTeammate')}</div>
        <div className="space-y-1">
          {agentRailProjects.map(({ project, sessions: projectSessions }) => {
            const running = projectSessions.some((session) => streamingSessions.has(session.id));
            const visibleCount = filteredSessionCountByProject.get(project.id) || 0;
            return <button key={`mobile-agent-${project.id}`} type="button" onClick={() => { setSelectedAgentProjectId(project.id); setAgentNavScope('work'); setMobileAgentPane('detail'); }} className="flex min-h-14 w-full items-center gap-3 rounded-xl px-3 text-left hover:bg-surface-800/70" aria-label={t('openAiConversations', { name: project.agent?.displayName || project.name })}>
              <AgentIdentityAvatar project={project} variant="list" showListAccent={false} className="h-10 w-10 shrink-0 rounded-xl" fallbackClassName="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-surface-800 text-[12px]" />
              <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-semibold text-surface-200">{project.agent?.displayName || project.name}</span><span className="mt-0.5 block text-[11px] text-surface-600">{t('conversationCount', { count: visibleCount })}</span></span>
              {running && <span className="tone-success flex items-center gap-1 text-[11px] font-semibold"><span className="h-2 w-2 rounded-full bg-current" />{t('running')}</span>}<span className="text-surface-600" aria-hidden="true">›</span>
            </button>;
          })}
        </div>
      </div>
    </nav>
  ) : (
    <div className="flex min-h-12 items-center border-b border-surface-800/80 bg-surface-850/95 px-2 min-[769px]:hidden" data-mobile-agent-pane="detail">
      <button type="button" onClick={() => setMobileAgentPane('root')} className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-surface-400 hover:bg-surface-800" aria-label={t('backToAiNavigation')}><svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="m15 19-7-7 7-7" /></svg></button>
      <div className="min-w-0 flex-1 truncate px-1 text-[14px] font-semibold text-surface-200">{mobileSelectedAgent?.agent?.displayName || mobileSelectedAgent?.name || (agentNavScope === 'team' ? t('aiTeamHome') : t('latestSessions'))}</div>
    </div>
  ) : null;

  // tabClass removed — tabs moved to Header

  return (
    <aside className="tower-sidebar w-full min-w-0 bg-surface-850/95 flex flex-col h-full shrink-0">
      {/* Sidebar header — collapse button + context label (tabs moved to Header) */}
      {(sidebarTab === 'pins' || sidebarTab === 'history') ? (
        <div className="flex items-center px-3 py-1.5 gap-2">
          <button
            onClick={() => setSidebarTab('sessions')}
            className="flex items-center gap-1 text-[13px] font-medium text-gray-500 hover:text-gray-300 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            {t('back')}
          </button>
          <span className="text-[14px] font-semibold text-gray-300">
            {sidebarTab === 'pins' ? t('pins') : t('history')}
          </span>
          <div className="flex-1" />
          {onCollapseSidebar && (
            <button onClick={onCollapseSidebar} className="p-1 text-surface-600 hover:text-gray-400 transition-colors" title={t('hideSidebar')}>
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
        </div>
      ) : sidebarTab === 'sessions' ? (
        <>
          <SidebarSessionsToolbar
            t={t}
            searchInputRef={searchInputRef}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            clearSearch={clearSearch}
            filterOpen={filterOpen}
            setFilterOpen={setFilterOpen}
            activeFilterLabels={activeFilterLabels}
            sessionKindFilter={sessionKindFilter}
            setKindFilter={setKindFilter}
            filterMy={filterMy}
            filterFav={filterFav}
            filterDone={filterDone}
            filterLabels={filterLabels}
            toggleFilter={(key) => {
              if (key === 'my') toggleFilter(key, filterMy, setFilterMy);
              if (key === 'fav') toggleFilter(key, filterFav, setFilterFav);
              if (key === 'done') toggleFilter(key, filterDone, setFilterDone);
              if (key === 'labels') toggleFilter(key, filterLabels, setFilterLabels);
            }}
            onCollapseSidebar={onCollapseSidebar}
          />
          {mobileAgentNavigation}
        </>
      ) : (
        <div className="flex items-center px-3 py-1.5">
          <span className="text-[13px] font-semibold text-gray-500 uppercase tracking-wider flex-1">
            {t('files')}
          </span>
          {onCollapseSidebar && (
            <button onClick={onCollapseSidebar} className="p-1 text-surface-600 hover:text-gray-400 transition-colors" title={t('hideSidebar')}>
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
        </div>
      )}

      {/* Tab content fills the remaining sidebar height. Session working files
          live in the hamburger menu, so the conversation list owns this space. */}
      <div
        ref={scrollContainerRef}
        className={`tower-sidebar-scroll flex-1 overflow-x-hidden pr-0 ${sidebarTab === 'files' ? '' : 'overflow-y-auto'} ${sidebarTab === 'sessions' && agentFirstEnabled ? `${mobileAgentPane === 'root' && !isSearching ? 'max-[768px]:hidden' : ''} min-[769px]:overflow-y-hidden` : ''}`}
        // Files owns scrolling inside its project/file panes. Inline overflowY
        // prevents utility ordering or stale generated CSS from re-enabling the
        // outer sidebar scrollbar and producing two visible scroll rails.
        style={{ touchAction: 'pan-y', minHeight: 0, overflowY: sidebarTab === 'files' ? 'hidden' : undefined }}
        onDragOver={(e) => {
          // Auto-scroll when dragging near top/bottom edges
          const container = scrollContainerRef.current;
          if (!container) return;
          const rect = container.getBoundingClientRect();
          const y = e.clientY - rect.top;
          const EDGE = 40;
          const SPEED = 8;
          if (y < EDGE) {
            container.scrollTop -= SPEED;
          } else if (y > rect.height - EDGE) {
            container.scrollTop += SPEED;
          }
        }}
      >
        {sidebarTab === 'sessions' ? (
          <div className={agentFirstEnabled ? 'relative flex h-full min-h-0 min-w-0' : undefined}>
            {agentFirstEnabled && !isSearching && (
              <nav className={`agent-nav-rail hidden h-full min-h-0 shrink-0 flex-col overflow-hidden border-r border-surface-800/80 bg-surface-900/95 px-2 py-2 transition-[width] duration-200 ease-out motion-reduce:transition-none min-[769px]:flex ${agentNavExpanded ? 'is-expanded w-44' : 'w-14'}`} aria-label={t('agentNavigation')}>
                <button
                  type="button"
                  onClick={toggleAgentNavExpanded}
                  className="mb-1 flex h-8 w-10 shrink-0 items-center justify-center rounded-md text-surface-600 transition-colors hover:bg-surface-800 hover:text-surface-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/70"
                  aria-label={agentNavExpanded ? t('collapseAiNameList') : t('expandAiNameList')}
                  title={agentNavExpanded ? t('collapseAiNameList') : t('expandAiNameList')}
                  aria-expanded={agentNavExpanded}
                >
                  <svg className={`h-3.5 w-3.5 transition-transform ${agentNavExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="m9 5 7 7-7 7" /></svg>
                </button>
                <div className="w-40 shrink-0">
                <button
                  type="button"
                  onClick={() => { setSelectedAgentProjectId(null); setAgentNavScope('work'); useFileStore.getState().activateChatSlot(); useSessionStore.getState().setActiveView('chat'); }}
                  className={`flex h-9 w-40 shrink-0 items-center rounded-xl text-[11px] font-bold transition-colors ${agentNavScope === 'work' && selectedAgentProjectId === null ? 'bg-primary-500/15 text-primary-700 ring-1 ring-primary-500/30 dark:text-primary-200' : 'text-surface-500 hover:bg-surface-800 hover:text-surface-200'}`}
                  aria-label={t('openRecentConversations')}
                  title={t('workNavTitle')}
                  aria-pressed={agentNavScope === 'work' && selectedAgentProjectId === null}
                >
                  <span className="grid h-9 w-10 shrink-0 place-items-center"><svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M12 7.25V12l3 1.75M4.75 8.5H2.5V6.25M3.2 8.1A9 9 0 1 1 3 15.5" /></svg></span>
                  <span className={`min-w-0 flex-1 truncate text-left text-[13px] font-semibold transition-opacity duration-150 motion-reduce:transition-none ${agentNavExpanded ? 'opacity-100' : 'opacity-0'}`}>{t('workNav')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => { setSelectedAgentProjectId(null); setAgentNavScope('team'); useSessionStore.getState().setActiveView('aiTeam'); window.requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-ai-team-scroll]')?.scrollTo({ top: 0 })); }}
                  className={`mt-1 flex h-9 w-40 shrink-0 items-center rounded-xl text-[11px] font-bold transition-colors ${agentNavScope === 'team' && selectedAgentProjectId === null ? 'bg-primary-500/15 text-primary-700 ring-1 ring-primary-500/30 dark:text-primary-200' : 'text-surface-500 hover:bg-surface-800 hover:text-surface-200'}`}
                  aria-label={t('openAiTeamHome')}
                  title={t('aiTeamNavTitle')}
                  aria-pressed={agentNavScope === 'team' && selectedAgentProjectId === null}
                >
                  <span className="grid h-9 w-10 shrink-0 place-items-center"><svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M4 19.5V8.25L12 3l8 5.25V19.5M8 19.5v-5h8v5" /></svg></span>
                  <span className={`min-w-0 flex-1 truncate text-left text-[13px] font-semibold transition-opacity duration-150 motion-reduce:transition-none ${agentNavExpanded ? 'opacity-100' : 'opacity-0'}`}>{t('aiTeamNav')}</span>
                </button>
                <div className={`mt-2 h-px bg-surface-800 transition-[width] duration-200 motion-reduce:transition-none ${agentNavExpanded ? 'w-40' : 'ml-1.5 w-7'}`} />
                </div>
                <div className="scrollbar-none min-h-0 w-40 flex-1 overflow-y-auto overflow-x-hidden pt-2 [mask-image:linear-gradient(to_bottom,transparent_0,black_10px,black_calc(100%-10px),transparent_100%)]">
                {agentRailProjects.map(({ project, sessions: projectSessions }) => {
                  const selected = selectedAgentProjectId === project.id;
                  const running = projectSessions.some((session) => streamingSessions.has(session.id));
                  return (
                    <button
                      key={project.id}
                      type="button"
                      onClick={() => { setSelectedAgentProjectId(project.id); setAgentNavScope('work'); }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setAgentRailMenu({ x: event.clientX, y: event.clientY, projectId: project.id });
                      }}
                      className={`relative flex h-10 w-40 shrink-0 items-center rounded-xl transition-colors ${selected ? 'bg-primary-500/12 ring-1 ring-primary-500/35' : 'hover:bg-surface-800/80'}`}
                      aria-label={t('openAiConversations', { name: project.agent?.displayName || project.name })}
                      title={project.agent?.displayName || project.name}
                      aria-pressed={selected}
                    >
                      {selected && <span className="absolute -left-1.5 h-5 w-0.5 rounded-r bg-primary-500" aria-hidden="true" />}
                      <span className="grid h-10 w-10 shrink-0 place-items-center"><AgentIdentityAvatar project={project} variant="list" showListAccent={false} className="h-7 w-7 shrink-0 rounded-lg" fallbackClassName="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface-800 text-[11px]" /></span>
                      <span className={`min-w-0 flex-1 truncate text-left text-[13px] font-medium text-surface-300 transition-opacity duration-150 motion-reduce:transition-none ${agentNavExpanded ? 'opacity-100' : 'opacity-0'}`}>{project.agent?.displayName || project.name}</span>
                      {running && <><span className={`tone-success h-2 w-2 shrink-0 rounded-full border-2 border-surface-900 bg-current transition-[transform] duration-200 motion-reduce:transition-none ${agentNavExpanded ? 'mr-2' : 'absolute bottom-0.5 left-8'}`} aria-hidden="true" /><span className="sr-only">{t('agentRunning')}</span></>}
                    </button>
                  );
                })}
                </div>
              </nav>
            )}
            {agentRailMenu && (() => {
              const group = groupedSessions?.groups.find(({ project }) => project.id === agentRailMenu.projectId);
              if (!group) return null;
              const { project, sessions: projectSessions } = group;
              const pinProject = useProjectStore.getState().pinProject;
              const unpinProject = useProjectStore.getState().unpinProject;
              const movePinnedProject = useProjectStore.getState().movePinnedProject;
              return (
                <ProjectContextMenu
                  x={agentRailMenu.x}
                  y={agentRailMenu.y}
                  project={project}
                  onRename={() => setAgentRailRename({ project, value: project.name })}
                  onDelete={async () => {
                    const token = localStorage.getItem('token');
                    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
                    const response = await fetch(`/api/projects/${project.id}/retire`, { method: 'POST', headers });
                    if (!response.ok) return;
                    useProjectStore.getState().removeProject(project.id);
                    projectSessions.forEach((session) => useSessionStore.getState().updateSessionMeta(session.id, { projectId: null }));
                    if (selectedAgentProjectId === project.id) setSelectedAgentProjectId(null);
                  }}
                  onClose={() => setAgentRailMenu(null)}
                  onNewChat={() => onNewSession(project.id)}
                  onOpenHome={() => {
                    rememberAgentWorkspaceLocation(project.id, 'home');
                    useFileStore.getState().openSystemTab('projectFiles', { refId: project.id, title: t('agentHomeTabTitle', { name: project.agent?.displayName || project.name }), icon: project.agent?.face || '✨' });
                    useSessionStore.getState().setActiveView('chat');
                  }}
                  sessionCount={projectSessions.length}
                  previewCount={projectSessions.length}
                  expanded={false}
                  onToggleExpanded={() => {}}
                  agentSessionPreviewLimit={getAgentSessionPreviewLimit()}
                  onChangeAgentSessionPreviewLimit={saveAgentSessionPreviewLimit}
                  showAgentSessionLimitOptions
                  isPinned={project.pinned === true}
                  onTogglePin={() => project.pinned ? unpinProject(project.id) : pinProject(project.id)}
                  onMovePinUp={() => movePinnedProject(project.id, 'up')}
                  onMovePinDown={() => movePinnedProject(project.id, 'down')}
                />
              );
            })()}
            {agentRailRename && (
              <div className="fixed inset-0 z-[160] grid place-items-center bg-black/30" onMouseDown={() => setAgentRailRename(null)}>
                <form
                  className="w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-surface-700 bg-surface-850 p-3 shadow-2xl"
                  onMouseDown={(event) => event.stopPropagation()}
                  onSubmit={async (event) => {
                    event.preventDefault();
                    const value = agentRailRename.value.trim();
                    if (!value) return;
                    const token = localStorage.getItem('token');
                    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                    if (token) headers.Authorization = `Bearer ${token}`;
                    const response = await fetch(`/api/projects/${agentRailRename.project.id}`, { method: 'PATCH', headers, body: JSON.stringify({ name: value }) });
                    if (response.ok) useProjectStore.getState().updateProject(agentRailRename.project.id, await response.json());
                    setAgentRailRename(null);
                  }}
                >
                  <label className="mb-2 block text-[13px] font-semibold text-surface-300">{t('renameAi')}</label>
                  <input autoFocus value={agentRailRename.value} onChange={(event) => setAgentRailRename({ ...agentRailRename, value: event.target.value })} className="h-9 w-full rounded-md border border-surface-700 bg-surface-900 px-2 text-[14px] text-surface-100 outline-none focus:border-primary-500" />
                  <div className="mt-3 flex justify-end gap-2"><button type="button" onClick={() => setAgentRailRename(null)} className="rounded-md px-3 py-1.5 text-[13px] text-surface-400 hover:bg-surface-800">{t('common:cancel')}</button><button type="submit" className="rounded-md bg-primary-600 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-primary-500">{t('common:save')}</button></div>
                </form>
              </div>
            )}
            <div className="scrollbar-none h-full min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
            <div className="px-3">
            {agentNavScope === 'team' && !selectedAgentProjectId && !isSearching && (() => {
              const teammateCount = agentRailProjects.length;
              const runningCount = agentRailProjects.filter(({ sessions: projectSessions }) => projectSessions.some((session) => streamingSessions.has(session.id))).length;
              const conversationCount = [...filteredSessionCountByProject.values()].reduce((sum, count) => sum + count, 0);
              const recentTurns = agentRailProjects.reduce((sum, { project }) => sum + Number((project as Project & { recentUsage?: { recent7?: number } }).recentUsage?.recent7 || 0), 0);
              return (
                <section className="py-2" aria-label={t('aiTeamHomeSummary')}>
                  <div className="px-1 pb-2">
                    <div className="flex min-h-10 items-center gap-2">
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary-500/12 text-primary-700 ring-1 ring-primary-500/25 dark:text-primary-200" aria-hidden="true"><svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M4 19.5V8.25L12 3l8 5.25V19.5M8 19.5v-5h8v5" /></svg></span>
                      <div className="min-w-0 flex-1"><div className="truncate text-[15px] font-semibold text-surface-100">{t('aiTeamHome')}</div><div className="text-[11px] text-surface-600">{t('aiTeamHomeDescription')}</div></div>
                    </div>
                    <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('tower-start-agent-academy'))} className="mt-2 flex min-h-10 w-full items-center gap-2 rounded-lg border border-primary-500/25 bg-primary-500/10 px-2 text-left text-[12px] font-semibold text-primary-700 hover:bg-primary-500/15 dark:text-primary-200"><svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg><span className="min-w-0 flex-1 truncate">{t('newAiTeammate')}</span></button>
                  </div>

                  <div className="grid grid-cols-4 border-y border-surface-800/80 py-2" aria-label={t('aiTeamUsageSummary')}>
                    <div className="px-1 text-center"><div className="text-[11px] text-surface-600">{t('teammates')}</div><div className="mt-0.5 text-[13px] font-bold text-surface-200">{teammateCount}</div></div>
                    <div className="border-l border-surface-800 px-1 text-center"><div className="text-[11px] text-surface-600">{t('running')}</div><div className="tone-success tone-text mt-0.5 text-[13px] font-bold">{runningCount}</div></div>
                    <div className="border-l border-surface-800 px-1 text-center"><div className="text-[11px] text-surface-600">{t('conversations')}</div><div className="mt-0.5 text-[13px] font-bold text-surface-200">{conversationCount.toLocaleString()}</div></div>
                    <div className="border-l border-surface-800 px-1 text-center"><div className="text-[11px] text-surface-600">{t('turnsLast7Days')}</div><div className="mt-0.5 text-[13px] font-bold text-surface-200">{recentTurns.toLocaleString()}</div></div>
                  </div>

                  <div className="flex items-center gap-2 px-1 pb-1 pt-3">
                    <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-semibold text-surface-300">{t('recentWork')}</div><div className="text-[11px] text-surface-600">{t('recentWorkDescription')}</div></div>
                    <button type="button" onClick={() => { const sessionStore = useSessionStore.getState(); sessionStore.setMobileTab('work'); sessionStore.setActiveView('work'); if (sessionStore.isMobile) sessionStore.setSidebarOpen(false); }} className="min-h-8 rounded-md px-2 text-[11px] font-semibold text-surface-500 hover:bg-surface-800 hover:text-primary-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/70">{t('viewAll')}</button>
                  </div>
                  <div className="py-1">
                    {teamRecentWorkstreamsLoading ? (
                      <div className="px-2 py-4 text-[12px] text-surface-600">{t('loadingRecentWork')}</div>
                    ) : teamRecentWorkstreams.length === 0 ? (
                      <div className="px-2 py-4 text-[12px] leading-5 text-surface-600">{t('noRecentWork')}</div>
                    ) : teamRecentWorkstreams.map((workstream) => (
                      <button key={`${workstream.projectId || 'shared'}:${workstream.id}`} type="button" onClick={() => {
                        const sessionStore = useSessionStore.getState();
                        sessionStore.setMobileTab('work');
                        sessionStore.setActiveView('work');
                        if (sessionStore.isMobile) sessionStore.setSidebarOpen(false);
                        window.requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('tower-open-project-work', { detail: { projectId: workstream.projectId || undefined, workstreamKey: workstream.workstreamKey, rangeHours: 24 * 30 } })));
                      }} className="group flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-surface-800/80">
                        <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${workstream.status === 'resolved' ? 'bg-surface-600' : workstream.status === 'waiting' ? 'bg-amber-400' : 'bg-emerald-400'}`} aria-hidden="true" />
                        <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-semibold text-surface-300 group-hover:text-surface-100">{workstream.title}</span><span className="mt-0.5 block truncate text-[10.5px] text-surface-650">{workstream.projectName}{workstream.todoLeft > 0 ? t('remainingWork', { count: workstream.todoLeft }) : ''}</span></span>
                        <span className="shrink-0 pt-0.5 text-[10px] text-surface-700">{workstream.lastAt ? new Date(workstream.lastAt).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) : ''}</span>
                      </button>
                    ))}
                  </div>
                </section>
              );
            })()}
            {selectedAgentProjectId && navigationGroupedSessions?.groups[0] && !isSearching && (() => {
              const { project, sessions: projectSessions } = navigationGroupedSessions.groups[0];
              return (
                <div className="sticky top-0 z-10 flex min-h-14 items-center gap-2 border-b border-surface-800/80 bg-surface-850/95 px-1 py-2 backdrop-blur-sm min-[769px]:static min-[769px]:min-h-12 min-[769px]:bg-transparent">
                  <AgentIdentityAvatar project={project} variant="list" showListAccent={false} className="h-7 w-7 shrink-0 rounded-lg" fallbackClassName="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface-800 text-[11px]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-semibold leading-5 tracking-[-0.01em] text-surface-100">{project.agent?.displayName || project.name}</div>
                    <div className="truncate whitespace-nowrap text-[11px] leading-4 text-surface-600">{t('conversationCount', { count: projectSessions.length })}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      rememberAgentWorkspaceLocation(project.id, 'home');
                      useFileStore.getState().openSystemTab('projectFiles', { refId: project.id, title: t('agentHomeTabTitle', { name: project.agent?.displayName || project.name }), icon: project.agent?.face || '✨' });
                      useSessionStore.getState().setActiveView('chat');
                      if (useSessionStore.getState().isMobile) useSessionStore.getState().setSidebarOpen(false);
                    }}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-surface-500 transition-colors hover:bg-surface-800 hover:text-primary-300"
                    aria-label={t('openNamedHome', { name: project.agent?.displayName || project.name })}
                    title={t('namedHome', { name: project.agent?.displayName || project.name })}
                  >
                    <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 10.5 12 3.75l8.25 6.75M5.25 9.75v9a1.5 1.5 0 0 0 1.5 1.5h3.5v-5.5h3.5v5.5h3.5a1.5 1.5 0 0 0 1.5-1.5v-9" /></svg>
                  </button>
                  <button type="button" onClick={() => onNewSession(project.id)} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-surface-500 transition-colors hover:bg-surface-800 hover:text-primary-300 min-[769px]:h-7 min-[769px]:w-7 min-[769px]:rounded-md" aria-label={t('startNewConversationWith', { name: project.agent?.displayName || project.name })} title={t('newSession')}>
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      setAgentRailMenu({ x: rect.right, y: rect.bottom + 4, projectId: project.id });
                    }}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-surface-500 transition-colors hover:bg-surface-800 hover:text-primary-300"
                    aria-label={t('openNamedActionsMenu', { name: project.agent?.displayName || project.name })}
                    title={t('more')}
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" /></svg>
                  </button>
                </div>
              );
            })()}
            {agentNavScope === 'work' && !isSearching && (() => {
              const selectedProjectSessions = selectedAgentProjectId
                ? (navigationGroupedSessions?.groups[0]?.sessions ?? [])
                : latestQuickSessions;
              const recentSessions = selectedProjectSessions;
              const selectedDeckGroups = new Map<string, SessionMeta[]>();
              const selectedUnlabeledSessions: SessionMeta[] = [];
              if (selectedAgentProjectId && filterLabels) {
                selectedProjectSessions.forEach((session) => {
                  if (!session.label) {
                    selectedUnlabeledSessions.push(session);
                    return;
                  }
                  const deckSessions = selectedDeckGroups.get(session.label) ?? [];
                  deckSessions.push(session);
                  selectedDeckGroups.set(session.label, deckSessions);
                });
              }
              const latestTotal = recentSessions.length;
              const latestDisplayedCount = Math.min(latestTotal, latestSessionsVisibleLimit);
              const latestVisibleSessions = recentSessions.slice(0, latestDisplayedCount);
              const latestSessionRuns = buildSidebarSessionTimelineModel({
                sessions: latestVisibleSessions,
                projects: allProjectsForMove,
                now: new Date(),
                locale: i18n.resolvedLanguage || i18n.language,
                todayLabel: t('today'),
                yesterdayLabel: t('yesterday'),
              });
              const latestRemainingCount = selectedAgentProjectId && filterLabels ? 0 : latestTotal - latestDisplayedCount;
              const latestNextBatchCount = Math.min(LATEST_SESSIONS_LOAD_BATCH, latestRemainingCount);
              return (
                <div className="pt-1 pb-1">
                  <div className={`space-y-0.5 ${selectedAgentProjectId ? 'pt-1' : ''}`}>
                      {selectedAgentProjectId && filterLabels && navigationGroupedSessions?.groups[0] && [...selectedDeckGroups.entries()].map(([label, deckSessions]) => (
                        <LabelGroup
                          key={`${selectedAgentProjectId}:${label}`}
                          label={label}
                          sessions={deckSessions}
                          projectId={selectedAgentProjectId}
                          isCollapsed={collapsedLabels.has(`${selectedAgentProjectId}::${label}`)}
                          onToggle={() => toggleLabelCollapsed(selectedAgentProjectId, label)}
                          onDropSession={(sessionId) => {
                            useSessionStore.getState().updateSessionMeta(sessionId, { label });
                            const token = localStorage.getItem('token');
                            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                            if (token) headers.Authorization = `Bearer ${token}`;
                            void fetch(`/api/sessions/${sessionId}`, { method: 'PATCH', headers, body: JSON.stringify({ label }) });
                          }}
                          activeSessionId={activeSessionId}
                          currentUsername={currentUsername}
                          onSelectSession={onSelectSession}
                          onDeleteSession={onDeleteSession}
                          onRenameSession={onRenameSession}
                          onToggleFavorite={onToggleFavorite}
                          onMoveSession={handleMoveSession}
                          projects={allProjectsForMove}
                          onNewSession={() => onNewSession(selectedAgentProjectId, label)}
                        />
                      ))}
                      {selectedAgentProjectId ? (
                        filterLabels ? (
                          selectedUnlabeledSessions.length > 0 && (
                            <LabelGroup
                              key={`${selectedAgentProjectId}:__uncategorized__`}
                              label="temp"
                              sessions={selectedUnlabeledSessions}
                              projectId={selectedAgentProjectId}
                              isCollapsed={collapsedLabels.has(`${selectedAgentProjectId}::__uncategorized__`)}
                              onToggle={() => toggleLabelCollapsed(selectedAgentProjectId, '__uncategorized__')}
                              onDropSession={(sessionId) => {
                                useSessionStore.getState().updateSessionMeta(sessionId, { label: null });
                                const token = localStorage.getItem('token');
                                const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                                if (token) headers.Authorization = `Bearer ${token}`;
                                void fetch(`/api/sessions/${sessionId}`, { method: 'PATCH', headers, body: JSON.stringify({ label: null }) });
                              }}
                              activeSessionId={activeSessionId}
                              currentUsername={currentUsername}
                              onSelectSession={onSelectSession}
                              onDeleteSession={onDeleteSession}
                              onRenameSession={onRenameSession}
                              onToggleFavorite={onToggleFavorite}
                              onMoveSession={handleMoveSession}
                              projects={allProjectsForMove}
                              onNewSession={() => onNewSession(selectedAgentProjectId)}
                              isSystemGroup
                            />
                          )
                        ) : latestVisibleSessions.map((session) => (
                          <SessionItem
                            key={`active-${session.id}`}
                            session={session}
                            isActive={session.id === activeSessionId}
                            currentUsername={currentUsername}
                            onSelect={onSelectSession}
                            onDelete={onDeleteSession}
                            onRename={onRenameSession}
                            onToggleFavorite={onToggleFavorite}
                            onMoveToProject={handleMoveSession}
                            projects={allProjectsForMove}
                            deleteActionIcon="archive"
                          />
                        ))
                      ) : (
                        <SidebarSessionTimeline
                          runs={latestSessionRuns}
                          activeSessionId={activeSessionId}
                          currentUsername={currentUsername}
                          projects={allProjectsForMove}
                          hideFromLatestLabel={t('hideFromLatest')}
                          onSelectSession={onSelectSession}
                          onDismissSession={dismissLatestSession}
                          onRenameSession={onRenameSession}
                          onToggleFavorite={onToggleFavorite}
                          onMoveSession={handleMoveSession}
                        />
                      )}
                      {latestRemainingCount > 0 && (
                        <button
                          type="button"
                          onClick={() => showMoreLatestSessions(latestTotal)}
                          className="w-full text-center py-1 text-[13px] text-surface-600 hover:text-gray-400 transition-colors"
                        >
                          {t('showMoreSessions', { count: latestNextBatchCount, remaining: latestRemainingCount })}
                        </button>
                      )}
                  </div>
                </div>
              );
            })()}
            {/* Grouped or flat session list */}
            {navigationGroupedSessions && !isSearching ? (
              <>
                {/* Project groups — personal pinned section first, then existing activity sort. */}
                {(() => {
                  const renderGroup = ({ project, sessions: groupSessions }: { project: Project; sessions: SessionMeta[] }) => {
                    const hasActivity = groupSessions.some((s) => streamingSessions.has(s.id));
                    const myUnreadCount = groupSessions.reduce((count, s) => {
                      const lastUserUsername = (s as SessionMeta & { lastUserUsername?: string | null }).lastUserUsername;
                      const attentionUsername = lastUserUsername || s.ownerUsername;
                      return count + (unreadSessions.has(s.id) && attentionUsername === currentUsername ? 1 : 0);
                    }, 0);
                    return (
                    <ProjectGroup
                      key={project.id}
                      project={project}
                      sessions={groupSessions}
                      collapsed={collapsedProjects.has(project.id) !== !project.pinned}
                      activeSessionId={activeSessionId}
                      currentUsername={currentUsername}
                      hasActivity={hasActivity}
                      myUnreadCount={myUnreadCount}
                      showLabels={filterLabels}
                      onToggleCollapsed={() => toggleProjectCollapsed(project.id)}
                      onSelectSession={onSelectSession}
                      onDeleteSession={onDeleteSession}
                      onRenameSession={onRenameSession}
                      onToggleFavorite={onToggleFavorite}
                      onNewSession={(label?: string) => onNewSession(project.id, label)}
                      onMoveSession={handleMoveSession}
                      projects={allProjectsForMove}
                    />
                    );
                  };
                  const orderedGroups = selectedAgentProjectId ? [] : [...navigationGroupedSessions.groups].sort((a, b) => {
                    const pinDelta = Number(b.project.pinned) - Number(a.project.pinned);
                    if (pinDelta !== 0) return pinDelta;
                    if (a.project.pinned && b.project.pinned) {
                      const orderDelta = pinnedOrder(a.project) - pinnedOrder(b.project);
                      if (orderDelta !== 0) return orderDelta;
                    }
                    return 0;
                  });
                  return <div className={agentFirstEnabled ? 'hidden' : 'pt-1'}>{orderedGroups.map(renderGroup)}</div>;
                })()}
                {/* temp — ungrouped sessions as a label-like subfolder */}
                {!selectedAgentProjectId && navigationGroupedSessions.ungrouped.length > 0 && (
                  <div className={agentFirstEnabled ? 'hidden' : undefined}>
                  <UngroupedDropZone onMoveSession={handleMoveSession} hasGroups={navigationGroupedSessions.groups.length > 0} hasUngrouped={navigationGroupedSessions.ungrouped.length > 0}>
                    <button
                      onClick={() => setUngroupedCollapsed(!ungroupedCollapsed)}
                      className="w-full flex items-center gap-1.5 px-1 py-1 mb-0.5 group"
                    >
                      <svg className={`w-3 h-3 text-surface-600 transition-transform ${ungroupedCollapsed ? '' : 'rotate-90'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                      <svg className="w-3 h-3 text-surface-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                      </svg>
                      <span className="text-[12px] text-surface-600 font-medium shrink-0">
                        {t('uncategorized')}
                      </span>
                      <span className="text-[11px] text-surface-700">({navigationGroupedSessions.ungrouped.length})</span>
                      <div className="flex-1" />
                    </button>
                    {!ungroupedCollapsed && (() => {
                      const total = navigationGroupedSessions.ungrouped.length;
                      const previewCount = getPreviewCount(navigationGroupedSessions.ungrouped);
                      const displayedCount = getSessionDisplayCount(total, previewCount, ungroupedExpanded, ungroupedVisibleLimit);
                      const visibleSessions = navigationGroupedSessions.ungrouped.slice(0, displayedCount);
                      const remainingCount = total - displayedCount;
                      const nextBatchCount = getNextSessionBatchCount(total, previewCount, ungroupedExpanded, ungroupedVisibleLimit);
                      return (
                        <div className="space-y-0.5 pl-2">
                          {visibleSessions.map((session) => (
                            <SessionItem
                              key={session.id}
                              session={session}
                              isActive={session.id === activeSessionId}
                              currentUsername={currentUsername}
                              onSelect={onSelectSession}
                              onDelete={onDeleteSession}
                              onRename={onRenameSession}
                              onToggleFavorite={onToggleFavorite}
                              onMoveToProject={handleMoveSession}
                              projects={allProjectsForMove}
                            />
                          ))}
                          {total > previewCount && (
                            <button
                              onClick={() => remainingCount > 0
                                ? showMoreUngroupedSessions(total, previewCount)
                                : toggleUngroupedExpanded(total, previewCount)}
                              data-sidebar-session-showall-project={remainingCount > 0 ? '__ungrouped__' : undefined}
                              className="w-full text-center py-1 text-[13px] text-surface-600 hover:text-gray-400 transition-colors"
                            >
                              {remainingCount > 0
                                ? t('showMoreSessions', { count: nextBatchCount, remaining: remainingCount })
                                : t('showLess')}
                            </button>
                          )}
                        </div>
                      );
                    })()}
                  </UngroupedDropZone>
                  </div>
                )}
                {filteredSessions.length === 0 && (
                  <p className="text-[15px] text-surface-700 px-2 py-6 text-center">{t('noSessionsYet')}</p>
                )}
              </>
            ) : (
              <>
                {filteredSessions.length === 0 && (
                  <p className="text-[15px] text-surface-700 px-2 py-6 text-center">
                    {searchQuery ? t('noResults') : t('noSessionsYet')}
                  </p>
                )}
                {/* Flat list — group by deck when filterLabels on and not searching */}
                {(() => {
                  const applyLabel = (sessionId: string, label: string | null) => {
                    useSessionStore.getState().updateSessionMeta(sessionId, { label });
                    const token = localStorage.getItem('token');
                    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                    if (token) headers['Authorization'] = `Bearer ${token}`;
                    fetch(`/api/sessions/${sessionId}`, { method: 'PATCH', headers, body: JSON.stringify({ label }) }).catch(() => {});
                  };

                  if (!isSearching && filterLabels) {
                    // Group by label
                    const labelGroups = new Map<string, SessionMeta[]>();
                    const unlabeled: SessionMeta[] = [];
                    for (const s of filteredSessions) {
                      if (s.label) {
                        const list = labelGroups.get(s.label) || [];
                        list.push(s);
                        labelGroups.set(s.label, list);
                      } else {
                        unlabeled.push(s);
                      }
                    }
                    const sortedLabels = [...labelGroups.entries()].sort((a, b) => {
                      const tA = Math.max(...a[1].map(s => new Date(s.updatedAt.includes('T') ? s.updatedAt : s.updatedAt.replace(' ', 'T') + 'Z').getTime()));
                      const tB = Math.max(...b[1].map(s => new Date(s.updatedAt.includes('T') ? s.updatedAt : s.updatedAt.replace(' ', 'T') + 'Z').getTime()));
                      return tB - tA;
                    });

                    if (sortedLabels.length === 0 && unlabeled.length === 0) return null;

                    // Render helper — used both for visible decks AND inside HiddenDecksAccordion
                    const renderLabelGroup = (label: string, labelSessions: SessionMeta[]) => {
                      const labelKey = `flat::${label}`;
                      const isCollapsed = collapsedLabels.has(labelKey);
                      return (
                        <LabelGroup
                          key={label}
                          label={label}
                          sessions={labelSessions}
                          projectId="flat"
                          isCollapsed={isCollapsed}
                          onToggle={() => toggleLabelCollapsed('flat', label)}
                          onDropSession={(sessionId) => applyLabel(sessionId, label)}
                          activeSessionId={activeSessionId}
                          currentUsername={currentUsername}
                          onSelectSession={onSelectSession}
                          onDeleteSession={onDeleteSession}
                          onRenameSession={onRenameSession}
                          onToggleFavorite={onToggleFavorite}
                          onMoveSession={handleMoveSession}
                          projects={allProjectsForMove}
                        />
                      );
                    };
                    return (
                      <div className="space-y-0.5">
                        {sortedLabels.map(([label, labelSessions]) => renderLabelGroup(label, labelSessions))}
                        {unlabeled.length > 0 && (
                          <LabelGroup
                            key="flat:__uncategorized__"
                            label="temp"
                            sessions={unlabeled}
                            projectId="flat"
                            isCollapsed={collapsedLabels.has('flat::__uncategorized__')}
                            onToggle={() => toggleLabelCollapsed('flat', '__uncategorized__')}
                            onDropSession={(sessionId) => applyLabel(sessionId, null)}
                            activeSessionId={activeSessionId}
                            currentUsername={currentUsername}
                            onSelectSession={onSelectSession}
                            onDeleteSession={onDeleteSession}
                            onRenameSession={onRenameSession}
                            onToggleFavorite={onToggleFavorite}
                            onMoveSession={handleMoveSession}
                            projects={allProjectsForMove}
                            isSystemGroup
                          />
                        )}
                      </div>
                    );
                  }

                  // Default flat list (searching or filterLabels off)
                  return (
                    <div className="space-y-0.5">
                      {filteredSessions.map((session) => (
                        <SessionItem
                          key={session.id}
                          session={session}
                          isActive={session.id === activeSessionId}
                          currentUsername={currentUsername}
                          onSelect={isSearching ? (s: any) => { onSelectSession(s); clearSearch(); } : onSelectSession}
                          onDelete={onDeleteSession}
                          onRename={onRenameSession}
                          onToggleFavorite={onToggleFavorite}
                          onMoveToProject={handleMoveSession}
                          projects={allProjectsForMove}
                        />
                      ))}
                    </div>
                  );
                })()}
              </>
            )}
            {/* Memory-card search snippets */}
            {searchResults && searchResults.filter(r => r.type === 'memory_card').length > 0 && (
              <div className="mt-2 border-t border-surface-800/50 pt-2">
                <div className="tone-warning tone-text text-[12px] opacity-80 uppercase tracking-wider font-medium mb-1 px-1">Memory</div>
                <div className="space-y-0.5">
                  {searchResults.filter(r => r.type === 'memory_card').map((r, i) => {
                    const target = sessions.find(s => s.id === r.sessionId);
                    const fallback = r.archived
                      ? { id: r.sessionId, shortCode: r.sessionShortCode, name: r.sessionName, projectId: null } as SessionMeta
                      : null;
                    const selectable = target || fallback;
                    if (!selectable) return null;
                    return (
                      <button
                        key={i}
                        onClick={() => { onSelectSession(selectable); clearSearch(); }}
                        className={`w-full text-left px-2 py-1.5 rounded hover:bg-[var(--tone-bg)] transition-colors tone-warning ${r.archived ? 'opacity-60' : ''}`}
                      >
                        <span className="tone-warning tone-text text-[13px] opacity-90 flex items-center gap-1.5">
                          <span className="truncate">{r.projectName ? `${r.projectName} · ${r.memoryTitle || r.sessionName}` : (r.memoryTitle || r.sessionName)}</span>
                          {r.archived && (
                            <span className="text-[11px] text-surface-600 bg-surface-800 px-1 py-px rounded shrink-0">
                              {t('archivedBadge')}
                            </span>
                          )}
                        </span>
                        <p className="text-[12px] text-surface-500 truncate mt-0.5">
                          <Highlighted text={r.snippet || r.memoryOutcome || ''} />
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {/* Message search snippets */}
            {searchResults && searchResults.filter(r => r.type === 'message').length > 0 && (
              <div className="mt-2 border-t border-surface-800/50 pt-2">
                <div className="text-[12px] text-surface-600 uppercase tracking-wider font-medium mb-1 px-1">{t('messages')}</div>
                <div className="space-y-0.5">
                  {searchResults.filter(r => r.type === 'message').map((r, i) => {
                    const target = sessions.find(s => s.id === r.sessionId);
                    // Session may live in History (archived) and therefore not appear
                    // in the in-memory `sessions` list. Fall back to a synthetic
                    // selection payload so clicking still opens it.
                    const fallback = r.archived
                      ? { id: r.sessionId, shortCode: r.sessionShortCode, name: r.sessionName, projectId: null } as SessionMeta
                      : null;
                    const selectable = target || fallback;
                    if (!selectable) return null;
                    return (
                      <button
                        key={i}
                        onClick={() => { onSelectSession(selectable); clearSearch(); }}
                        className={`w-full text-left px-2 py-1.5 rounded hover:bg-surface-800/60 transition-colors ${r.archived ? 'opacity-60' : ''}`}
                      >
                        <span className="text-[13px] text-gray-400 flex items-center gap-1.5">
                          <span className="truncate">{r.projectName ? `${r.projectName} · ${r.sessionName}` : r.sessionName}</span>
                          {r.archived && (
                            <span className="text-[11px] text-surface-600 bg-surface-800 px-1 py-px rounded shrink-0">
                              {t('archivedBadge')}
                            </span>
                          )}
                        </span>
                        <p className="text-[12px] text-surface-600 truncate mt-0.5">
                          <Highlighted text={r.snippet} />
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          </div>
          </div>
        ) : sidebarTab === 'files' ? (
          // Keep the Files tab height-bound to the sidebar. `min-h-full` lets this
          // root grow with the file tree and revives the outer sidebar scroll rail.
          // The project rail hides its scrollbar chrome; the file pane below is the
          // single visible vertical scroll owner.
          <div data-sidebar-files-root="true" className={`h-full min-h-0 overflow-hidden ${isMobile ? 'flex flex-col' : 'grid grid-cols-[176px_minmax(0,1fr)]'}`}>
            {!isMobile && (
              <nav className="flex min-h-0 flex-col border-r border-surface-800/80 bg-surface-900/95 px-2 py-2" aria-label={t('selectProjectFolder')}>
                <div className="relative mb-2 shrink-0">
                  <svg className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-surface-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.35-4.35m2.1-5.4a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" /></svg>
                  <input value={folderProjectQuery} onChange={(event) => setFolderProjectQuery(event.target.value)} placeholder={t('searchProjects')} className="h-8 w-full rounded-lg border border-surface-800 bg-surface-950 pl-8 pr-2 text-[12px] text-surface-200 outline-none placeholder:text-surface-650 focus:border-primary-500/60" aria-label={t('searchFolderProjects')} />
                </div>
                <div className="scrollbar-none min-h-0 flex-1 space-y-1 overflow-y-auto">
                  {folderProjects.map((project) => {
                    const selected = activeFileProject?.id === project.id;
                    return <button key={project.id} type="button" onClick={() => {
                      rememberAgentWorkspaceLocation(project.id, 'files');
                      useSettingsStore.getState().setCapabilityProjectId(project.id);
                      useFileStore.getState().clearSelection();
                    }} className={`relative flex min-h-11 w-full items-center gap-2 rounded-xl px-2 text-left transition-colors ${selected ? 'bg-primary-500/12 text-primary-700 ring-1 ring-primary-500/35 dark:text-primary-200' : 'text-surface-400 hover:bg-surface-800/80 hover:text-surface-200'}`} aria-pressed={selected} title={project.agent?.displayName || project.name}>
                      {selected && <span className="absolute -left-2 h-5 w-0.5 rounded-r bg-primary-500" aria-hidden="true" />}
                      <AgentIdentityAvatar project={project} variant="list" showListAccent={false} className="h-7 w-7 shrink-0 rounded-lg" fallbackClassName="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface-800 text-[11px]" />
                      <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{project.agent?.displayName || project.name}</span>
                    </button>;
                  })}
                  {folderProjects.length === 0 && <p className="px-2 py-4 text-[12px] text-surface-600">{t('noMatchingProjects')}</p>}
                </div>
              </nav>
            )}
            <div data-sidebar-files-scroll="true" className="flex min-h-0 min-w-0 flex-col overflow-x-hidden overflow-y-auto overscroll-contain">
            {isMobile && mobileProjectPickerOpen && (
              <section className="min-h-full px-3 py-3">
                <button type="button" onClick={() => { setMobileProjectPickerOpen(false); setMobileProjectQuery(''); }} className="mb-2 flex min-h-9 items-center gap-1 rounded-lg px-1 text-sm font-semibold text-surface-300 active:bg-surface-800"><span aria-hidden="true">‹</span><span>{t('files')}</span></button>
                <h2 className="px-1 text-base font-bold text-surface-100">{t('selectProject')}</h2>
                <div className="relative mt-3">
                  <svg className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-surface-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="m21 21-4.35-4.35m2.1-5.4a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" /></svg>
                  <input value={mobileProjectQuery} onChange={(event) => setMobileProjectQuery(event.target.value)} placeholder={t('searchProjects')} className="h-10 w-full rounded-xl border border-surface-800 bg-surface-950 pl-10 pr-3 text-sm text-surface-200 outline-none placeholder:text-surface-650 focus:border-primary-500/60" aria-label={t('searchFileProjects')} />
                </div>
                <div className="mt-2 divide-y divide-surface-800/80">
                  {projectsSortedForFiles.filter((project) => project.rootPath && !project.archived && `${project.agent?.displayName || ''} ${project.name}`.toLowerCase().includes(mobileProjectQuery.trim().toLowerCase())).map((project) => {
                    const selected = project.id === activeFileProject?.id;
                    return <button key={project.id} type="button" onClick={() => {
                      rememberAgentWorkspaceLocation(project.id, 'files');
                      useSettingsStore.getState().setCapabilityProjectId(project.id);
                      useFileStore.getState().clearSelection();
                      setMobileProjectPickerOpen(false);
                      setMobileProjectQuery('');
                    }} className={`flex min-h-12 w-full items-center gap-3 px-1 text-left ${selected ? 'font-bold text-primary-200' : 'text-surface-300 active:bg-surface-800'}`}>
                      <AgentIdentityAvatar project={project} variant="list" showListAccent={false} className="h-8 w-8 shrink-0 rounded-lg" fallbackClassName="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-800 text-[11px]" />
                      <span className="min-w-0 flex-1 truncate text-sm">{project.agent?.displayName || project.name}</span>
                      {selected && <span className="shrink-0 text-primary-300" aria-hidden="true">✓</span>}
                    </button>;
                  })}
                </div>
              </section>
            )}
            {isMobile && !mobileProjectPickerOpen && mobileQuickFilesView === null && (
              <section className="border-b border-surface-800 px-3 py-3">
                <div className="mb-2 px-0.5 text-[11px] font-bold uppercase tracking-[0.12em] text-surface-600">{t('quickFiles')}</div>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => setMobileQuickFilesView('session')} className="flex min-h-12 items-center gap-2 rounded-xl border border-surface-800 bg-surface-900 px-3 text-left active:bg-surface-800"><span className="min-w-0 flex-1 text-[12px] font-semibold text-surface-200">{t('thisConversationFiles')}</span><span className="text-surface-600">›</span></button>
                  <button type="button" onClick={() => setMobileQuickFilesView('recent')} disabled={mobileDocumentRecents.length === 0} className="flex min-h-12 items-center gap-2 rounded-xl border border-surface-800 bg-surface-900 px-3 text-left active:bg-surface-800 disabled:opacity-45"><span className="min-w-0 flex-1 text-[12px] font-semibold text-surface-200">{t('recentDocuments')}</span><span className="text-xs tabular-nums text-surface-600">{mobileDocumentRecents.length} ›</span></button>
                </div>
              </section>
            )}
            {isMobile && !mobileProjectPickerOpen && mobileQuickFilesView === 'recent' && (
              <section className="min-h-full px-3 py-3">
                <button type="button" onClick={() => setMobileQuickFilesView(null)} className="mb-2 flex min-h-9 items-center gap-1 rounded-lg px-1 text-sm font-semibold text-surface-300 active:bg-surface-800"><span aria-hidden="true">‹</span><span>{t('files')}</span></button>
                <h2 className="px-1 text-base font-bold text-surface-100">{t('recentDocuments')}</h2>
                <div className="mt-2 divide-y divide-surface-800/80">{mobileDocumentRecents.map((document) => <button key={document.path} type="button" onClick={() => onFileClick(document.path)} className="flex w-full items-center gap-2 px-1 py-3 text-left active:bg-surface-800" title={document.path}><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary-500/10 text-sm text-primary-300" aria-hidden="true">📄</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-surface-200">{document.name}</span><span className="block truncate text-[10px] text-surface-600">{document.path}</span></span></button>)}</div>
              </section>
            )}
            {isMobile && !mobileProjectPickerOpen && mobileQuickFilesView === 'session' && <SessionFilesMenuSection activeSessionId={activeSessionId} placement="inline" isMobile onInlineBack={() => setMobileQuickFilesView(null)} onFileClick={onFileClick} />}
            {isMobile && !mobileProjectPickerOpen && mobileQuickFilesView === null && (
              <div className="border-b border-surface-800 bg-surface-900 px-3 py-3">
                <div className="mb-2 px-0.5 text-[12px] font-bold text-surface-400">{t('projectFiles')}</div>
                <div className="block text-[11px] font-bold text-surface-500">{t('project')}
                  <button
                    type="button"
                    onClick={() => setMobileProjectPickerOpen(true)}
                    className="mt-1.5 flex min-h-10 w-full items-center gap-2 rounded-xl border border-surface-700 bg-surface-950 px-3 text-left text-sm font-bold text-surface-100 outline-none focus:border-primary-500"
                    aria-label={t('selectProjectForFiles')}
                  >
                    <span className="min-w-0 flex-1 truncate">{activeFileProject?.agent?.displayName || activeFileProject?.name || t('selectProject')}</span>
                    <span className="shrink-0 text-surface-500" aria-hidden="true">›</span>
                  </button>
                </div>
              </div>
            )}
            {mobileQuickFilesView === null && <div className="hidden">
            <button
              type="button"
              data-tour-id="personal-todos"
              onClick={() => onPersonalTodosClick?.()}
              className="group mx-2 mb-1 flex h-9 items-center gap-2 rounded-md px-2 text-left transition hover:bg-surface-800"
              title={t('openMyTodoInViewer')}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-primary-500/50 bg-primary-500/10 text-[12px] text-primary-300" aria-hidden="true">✓</span>
              <span className="min-w-0 flex-1 truncate text-[17px] font-bold leading-5 text-gray-300">{t('myTodo')}</span>
              <span className="text-[12px] text-surface-600 transition group-hover:text-surface-300">{t('viewer')} ›</span>
            </button>
            <section className="mx-2 mb-2">
              <button
                type="button"
                onClick={togglePersonalFiles}
                className="group/personal flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left transition hover:bg-surface-800"
                aria-expanded={personalFilesOpen}
              >
                <svg className={`h-3.5 w-3.5 shrink-0 text-surface-600 transition-transform group-hover/personal:text-surface-300 ${personalFilesOpen ? '' : '-rotate-90'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
                <span className="min-w-0 flex-1 truncate text-[17px] font-bold leading-5 text-gray-300">{t('viewMyFiles')}</span>
                {!personalFilesLoading && personalFiles.length > 0 && <span className="text-[11px] tabular-nums text-surface-600">{personalFiles.length}</span>}
              </button>
              {personalFilesOpen && (
                <div className="ml-1.5 border-l border-surface-700/25 py-1 pl-2">
                  {personalFilesLoading ? (
                    <p className="px-2 py-2 text-[12px] text-surface-500">{t('loadingMyFiles')}</p>
                  ) : personalFilesError ? (
                    <div className="px-2 py-2 text-[12px] text-red-300">
                      <p>{personalFilesError}</p>
                      <button type="button" onClick={() => { void loadPersonalFiles(); }} className="mt-1 font-semibold text-surface-200 hover:text-surface-50">{t('retry')}</button>
                    </div>
                  ) : personalFiles.length === 0 ? (
                    <p className="px-2 py-2 text-[12px] text-surface-500">{t('noPersonalFilesHint')}</p>
                  ) : (
                    <div className="max-h-64 overflow-y-auto">
                      {personalFiles.map((file) => (
                        <div key={file.id} className="group flex h-[22px] items-center rounded text-[14px] text-gray-300 hover:bg-surface-800" onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setPersonalFileMenu({ x: event.clientX, y: event.clientY, file });
                        }}>
                          <button type="button" onClick={() => onPersonalFileClick?.(file.uri)} className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-left" title={file.relativePath}>
                            <span className="w-3 shrink-0" />
                            <span className="shrink-0 text-[13px] text-blue-400" aria-hidden="true">▤</span>
                            <span className="min-w-0 flex-1 truncate text-gray-400 group-hover:text-gray-200">{file.name}</span>
                          </button>
                          <button type="button" onClick={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect();
                            setPersonalFileMenu({ x: rect.right, y: rect.bottom, file });
                          }} className="mr-1 hidden h-5 w-5 shrink-0 items-center justify-center rounded text-surface-500 hover:bg-surface-700 hover:text-surface-100 group-hover:flex focus:flex" aria-label={t('namedFileActions', { name: file.name })} title={t('fileActions')}>⋯</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>
            {/* User pins live at the top of Files so pinned files feel like personal shortcuts, not a separate mode. */}
            <PinList
              embedded
              hideEmpty
              onPinClick={(pin) => onPinClick?.(pin)}
              onUnpin={(id) => onUnpinFile?.(id)}
            />
            </div>}
            {mobileQuickFilesView === null && <div className="px-2 space-y-1 flex-1 flex flex-col">
              {!isMobile && (
                <SessionFilesMenuSection
                  activeSessionId={activeSessionId}
                  placement="sidebar"
                  onFileClick={onFileClick}
                />
              )}
              {/* Files is quick navigation for the current Agent project. */}
              {activeFileProject ? (
                <>
                  <FilesToolbar
                    onRefresh={onRequestFileTree}
                    onOpenWorkspace={() => {
                      useSettingsStore.getState().setCapabilityProjectId(activeFileProject.id);
                      useSessionStore.getState().setActiveView('projectFiles');
                      useSessionStore.getState().setSidebarOpen(false);
                    }}
                    projects={[activeFileProject]}
                  />
                  <div className="min-w-0 flex-1 overflow-x-hidden">
                    {!isMobile && <div className="mb-1 mt-2 px-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-surface-600">{t('workspaceFiles')}</div>}
                    <SidebarProjectFiles
                      key={activeFileProject.id}
                      project={activeFileProject}
                      onFileClick={onFileClick}
                      onPinFile={onPinFile}
                      onNewSessionInFolder={onNewSessionInFolder}
                    />
                </div>
              </>
              ) : (
                <div className="mx-2 mt-3 rounded-lg border border-surface-800 px-3 py-4 text-sm text-surface-500">{t('selectAiTeammateForFiles')}</div>
              )}

              <>
              <div className="flex-1">

              {/* Shared with me */}
              {false && sharedWithMe.length > 0 && (
                <div className="mt-3 px-2">
                  <div className="text-[12px] text-gray-600 uppercase tracking-wide font-medium mb-1.5 px-1">
                    {t('sharedWithMe')}
                  </div>
                  <div className="space-y-0.5">
                    {sharedWithMe.map(s => (
                      <button
                        key={s.id}
                        onClick={() => onFileClick(s.file_path)}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[14px] text-gray-400 hover:text-white hover:bg-surface-700/50 transition-colors text-left"
                      >
                        <svg className="tone-success tone-text w-3.5 h-3.5 opacity-60 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                        </svg>
                        <span className="truncate flex-1">{s.file_path.split('/').pop()}</span>
                        <span className="text-[12px] text-gray-600 shrink-0">@{s.owner_username}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Multi-select toolbar */}
            {false && <SelectionToolbar onRefresh={() => { useFileStore.getState().bumpRefreshTrigger(); onRequestFileTree(); }} />}

              {/* Bulk management stays in the Agent Home's 전체 파일 workspace. */}
              {false && <FilesDropZone projects={allProjects} onRefresh={onRequestFileTree} />}
              </>
            </div>}
            </div>
          </div>
        ) : sidebarTab === 'prompts' ? (
          <div className="px-3">
            {onPromptAdd && (
              <button
                onClick={onPromptAdd}
                className="w-full flex items-center justify-center gap-1.5 py-2 mb-2 rounded-md border border-dashed border-surface-700 text-[13px] text-surface-600 hover:text-primary-400 hover:border-primary-500/50 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                {t('addPrompt')}
              </button>
            )}
            {prompts.length === 0 ? (
              <p className="text-[14px] text-surface-700 px-2 py-6 text-center">
                {t('noSavedPrompts')}
              </p>
            ) : (
              <div className="space-y-0.5">
                {prompts.map((prompt) => (
                  <PromptItemComponent
                    key={prompt.id}
                    prompt={prompt}
                    onClick={(p) => onPromptClick?.(p)}
                    onEdit={(p) => onPromptEdit?.(p)}
                    onDelete={(id) => onPromptDelete?.(id)}
                  />
                ))}
              </div>
            )}
          </div>
        ) : sidebarTab === 'history' ? (
          <HistoryPanel />
        ) : sidebarTab === 'pins' ? (
          <PinList
            onPinClick={(pin) => onPinClick?.(pin)}
            onUnpin={(id) => onUnpinFile?.(id)}
          />
        ) : null}
      </div>

      {personalRenameFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4" onMouseDown={() => setPersonalRenameFile(null)}>
          <div className="w-full max-w-sm rounded-xl border border-surface-700 bg-surface-900 p-4 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
            <h3 className="text-[15px] font-semibold text-surface-100">{t('renamePersonalFile')}</h3>
            <p className="mt-1 truncate text-[12px] text-surface-500">{personalRenameFile.relativePath}</p>
            <input
              autoFocus
              value={personalRenameValue}
              onChange={(event) => setPersonalRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void renamePersonalSidebarFile();
                if (event.key === 'Escape') setPersonalRenameFile(null);
              }}
              className="mt-3 h-9 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 text-sm text-surface-100 outline-none focus:border-primary-500"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setPersonalRenameFile(null)} className="rounded-lg px-3 py-2 text-sm text-surface-400 hover:bg-surface-800 hover:text-surface-100">{t('common:cancel')}</button>
              <button type="button" onClick={() => { void renamePersonalSidebarFile(); }} className="rounded-lg bg-primary-500 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-400">{t('rename')}</button>
            </div>
          </div>
        </div>
      )}
      {personalFileMenu && (
        <div
          className="fixed z-50 min-w-[180px] rounded-lg border border-surface-700 bg-surface-800 py-1 text-[13px] text-surface-200 shadow-xl"
          style={{ left: personalFileMenu.x, top: personalFileMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onMouseLeave={() => setPersonalFileMenu(null)}
          role="menu"
        >
          <button type="button" onClick={() => { onPersonalFileClick?.(personalFileMenu.file.uri); setPersonalFileMenu(null); }} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-700" role="menuitem">{t('open')}</button>
          <button type="button" onClick={() => {
            const file = personalFileMenu.file;
            setPersonalRenameFile(file);
            setPersonalRenameValue(file.name.replace(/\.md$/i, ''));
            setPersonalFileMenu(null);
          }} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-700" role="menuitem">{t('rename')}</button>
          <button type="button" onClick={() => { void navigator.clipboard.writeText(personalFileMenu.file.uri); setPersonalFileMenu(null); }} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-700" role="menuitem">{t('copyPath')}</button>
          <div className="my-1 border-t border-surface-700/70" />
          <button type="button" onClick={() => { void archivePersonalSidebarFile(personalFileMenu.file); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-300 hover:bg-red-950/30" role="menuitem">{t('moveToArchive')}</button>
        </div>
      )}



      {/* Footer — version */}
      <div>
        <div className="px-4 py-2 flex items-center justify-end">
          <span className="text-[12px] font-semibold text-surface-800">v{serverVersion ?? '—'}</span>
        </div>
      </div>
    </aside>
  );
}

/** Breadcrumb navigation for file tree root */
function Breadcrumb({ treeRoot, onNavigate }: { treeRoot: string; onNavigate: (path?: string) => void }) {
  const { t } = useTranslation('layout');
  if (!treeRoot) return null;

  // Replace /home/<user> with ~
  const display = treeRoot.replace(/^\/home\/[^/]+/, '~');
  const segments = display.split('/').filter(Boolean);

  // Build absolute path for each segment click
  const buildPath = (index: number): string => {
    // Reconstruct from original treeRoot segments
    const originalSegments = treeRoot.split('/').filter(Boolean);
    // If display starts with ~, first segment maps to /home/<user>
    if (display.startsWith('~')) {
      // index 0 = ~ = /home/<user>
      if (index === 0) {
        const homeMatch = treeRoot.match(/^\/home\/[^/]+/);
        return homeMatch ? homeMatch[0] : '/';
      }
      // index 1+ maps to originalSegments after the home dir parts
      const homeMatch = treeRoot.match(/^\/home\/[^/]+/);
      const homePrefix = homeMatch ? homeMatch[0] : '';
      const rest = treeRoot.slice(homePrefix.length).split('/').filter(Boolean);
      return homePrefix + '/' + rest.slice(0, index).join('/');
    }
    return '/' + originalSegments.slice(0, index + 1).join('/');
  };

  const parentPath = treeRoot.replace(/\/[^/]+\/?$/, '') || '/';

  return (
    <div className="flex items-center gap-0.5 px-1 py-1.5 mb-1 text-[13px] font-mono overflow-x-auto scrollbar-none">
      {segments.map((seg, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="text-surface-700 mx-0.5">/</span>}
          {i < segments.length - 1 ? (
            <button
              onClick={() => onNavigate(buildPath(i))}
              className="text-surface-600 hover:text-primary-400 transition-colors truncate max-w-[80px] shrink-0"
              title={buildPath(i)}
            >
              {seg}
            </button>
          ) : (
            <span className="text-gray-300 truncate max-w-[100px]">{seg}</span>
          )}
        </React.Fragment>
      ))}
      <button
        onClick={() => onNavigate(parentPath)}
        disabled={treeRoot === '/'}
        className="ml-1 p-0.5 rounded text-surface-600 hover:text-primary-400 hover:bg-surface-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
        title={t('parentDirectory')}
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
        </svg>
      </button>
    </div>
  );
}

/** Compact toolbar shown at top of Files tab — New, Upload, show hidden, refresh */
/** Toggle button for multi-select mode */
function SelectModeToggle() {
  const selectMode = useFileStore((s) => s.selectMode);
  const toggleSelectMode = useFileStore((s) => s.toggleSelectMode);
  return (
    <button
      onClick={() => toggleSelectMode()}
      className={`p-1 rounded transition-colors ${
        selectMode
          ? 'text-primary-400 bg-primary-600/20'
          : 'text-surface-600 hover:text-primary-400 hover:bg-surface-800'
      }`}
      title={selectMode ? 'Exit select mode' : 'Select files (Ctrl+Click)'}
    >
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
      </svg>
    </button>
  );
}

function SortMenuItem({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-[14px] transition-colors ${
        active ? 'text-primary-300 bg-primary-500/10' : 'text-gray-400 hover:text-gray-200 hover:bg-surface-700/70'
      }`}
    >
      <span className={`w-3.5 text-[12px] ${active ? 'text-primary-300' : 'text-transparent'}`}>✓</span>
      <span className="truncate">{children}</span>
    </button>
  );
}

function FilesToolbar({
  onRefresh,
  onOpenWorkspace,
  projects,
}: {
  onRefresh: (path?: string) => void;
  onOpenWorkspace: () => void;
  projects: { id: string; name: string; rootPath?: string | null; color?: string }[];
}) {
  const { t } = useTranslation('layout');
  const isMobile = useSessionStore((s) => s.isMobile);
  const showHidden = useFileStore((s) => s.showHidden);
  const toggleShowHidden = useFileStore((s) => s.toggleShowHidden);
  const bumpRefreshTrigger = useFileStore((s) => s.bumpRefreshTrigger);
  const projectSortMode = useFileStore((s) => s.projectSortMode);
  const fileSortMode = useFileStore((s) => s.fileSortMode);
  const setProjectSortMode = useFileStore((s) => s.setProjectSortMode);
  const setFileSortMode = useFileStore((s) => s.setFileSortMode);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<string | null>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const uploadMenuRef = useRef<HTMLDivElement>(null);

  const handleToggleHidden = () => {
    toggleShowHidden();
    setTimeout(() => onRefresh(), 50);
  };

  // Close popovers on outside click
  useEffect(() => {
    if (!sortMenuOpen && !uploadMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) setSortMenuOpen(false);
      if (uploadMenuRef.current && !uploadMenuRef.current.contains(e.target as Node)) setUploadMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [sortMenuOpen, uploadMenuOpen]);

  const projectsWithPath = projects.filter(p => p.rootPath);

  const handleUploadClick = () => {
    if (projectsWithPath.length === 0) {
      toastError('No project folder available');
      return;
    }
    if (projectsWithPath.length === 1) {
      uploadTargetRef.current = projectsWithPath[0].rootPath!;
      fileInputRef.current?.click();
      return;
    }
    setUploadMenuOpen((v) => !v);
  };

  const handleUploadTargetClick = (targetDir: string) => {
    uploadTargetRef.current = targetDir;
    setUploadMenuOpen(false);
    fileInputRef.current?.click();
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const uploadTarget = uploadTargetRef.current;
    if (!uploadTarget) { toastError('Choose an upload folder first'); return; }

    const formData = new FormData();
    formData.append('targetDir', uploadTarget);
    for (const file of Array.from(files)) formData.append('files', file);
    try {
      const token = localStorage.getItem('token');
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('/api/files/upload', { method: 'POST', headers, body: formData });
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) { toastError(`Upload failed (${res.status}): server returned non-JSON response`); return; }
      const data = await res.json();
      if (!res.ok) { emitProductNotice({ code: 'sidebar.upload.failed', technicalDetail: data.error, context: { status: res.status } }); return; }
      const ok = data.results.filter((r: any) => !r.error);
      const fail = data.results.filter((r: any) => r.error);
      const targetName = uploadTarget.split('/').pop() || uploadTarget;
      notifyUploadResult({ ok: ok.length, fail: fail.length }, `${targetName}/`);
      bumpRefreshTrigger();
    } catch (err) {
      emitProductNotice({ code: 'sidebar.upload.failed', technicalDetail: err });
    }
    e.target.value = '';
    uploadTargetRef.current = null;
  };

  const iconBtnClass = 'p-1 rounded text-surface-600 hover:text-primary-400 hover:bg-surface-800 transition-colors';

  return (
    <div className="px-1 pt-1 pb-1 space-y-1.5">
      {/* Action buttons row */}
      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        <button
          type="button"
          onClick={onOpenWorkspace}
          className={iconBtnClass}
          title={t('openFileWorkspace')}
          aria-label={t('openFileWorkspace')}
        >
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5h5v5m0-5-7 7M19 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4" />
          </svg>
        </button>
        {/* File picker complements precise folder drag-and-drop. Keep this
            icon-only because the file-tree toolbar has intentionally narrow widths. */}
        <div className="relative" ref={uploadMenuRef}>
          <button
            type="button"
            onClick={handleUploadClick}
            className={`${iconBtnClass} tone-success hover:!text-[var(--tone-text)]`}
            title={projectsWithPath.length === 1
              ? t('filesWillBeAddedTo', { destination: projectsWithPath[0].name })
              : t('chooseFilesFromComputer')}
            aria-label={t('addFiles')}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
          </button>
          {uploadMenuOpen && (
            <div className="absolute left-0 top-full mt-1 z-50 bg-surface-800 border border-surface-700 rounded-lg shadow-xl py-1 min-w-[220px]">
              <div className="px-3 py-1 text-[12px] text-gray-500 font-medium">{t('selectUploadProject')}</div>
              {projectsWithPath.map(p => (
                <button
                  key={p.id}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[14px] text-gray-300 hover:bg-primary-600/30 hover:text-white text-left"
                  onClick={() => handleUploadTargetClick(p.rootPath!)}
                  title={p.rootPath || undefined}
                >
                  <svg className="w-3.5 h-3.5 text-yellow-400/70 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                  </svg>
                  <span className="min-w-0 flex-1 truncate">{p.name}/</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <input ref={fileInputRef} type="file" multiple hidden onChange={handleFileUpload} />

        <div className="flex-1" />

        {/* Sort menu */}
        <div className="relative" ref={sortMenuRef}>
          <button
            onClick={() => setSortMenuOpen((v) => !v)}
            className={iconBtnClass}
            title={t('sort')}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7h13M3 12h9M3 17h5m11-9l2 2m0 0l2-2m-2 2V4m0 12l-2-2m0 0l-2 2m2-2v6" />
            </svg>
          </button>
          {sortMenuOpen && (
            <div className="absolute right-0 top-full mt-1 z-50 w-56 bg-surface-800 border border-surface-700 rounded-lg shadow-xl py-1">
              {!isMobile && <>
                <div className="px-3 py-1.5 text-[12px] text-gray-500 uppercase tracking-wide font-semibold">{t('workspaceSort')}</div>
                <SortMenuItem active={projectSortMode === 'pinned-recent'} onClick={() => setProjectSortMode('pinned-recent')}>{t('pinnedThenRecent')}</SortMenuItem>
                <SortMenuItem active={projectSortMode === 'recent'} onClick={() => setProjectSortMode('recent')}>{t('recentActivity')}</SortMenuItem>
                <SortMenuItem active={projectSortMode === 'name'} onClick={() => setProjectSortMode('name')}>{t('nameAz')}</SortMenuItem>
                <SortMenuItem active={projectSortMode === 'created'} onClick={() => setProjectSortMode('created')}>{t('newestCreated')}</SortMenuItem>
                <div className="my-1 border-t border-surface-700/70" />
              </>}
              <div className="px-3 py-1.5 text-[12px] text-gray-500 uppercase tracking-wide font-semibold">{t('fileSort')}</div>
              <SortMenuItem active={fileSortMode === 'folders-name'} onClick={() => { setFileSortMode('folders-name'); setSortMenuOpen(false); }}>{t('foldersThenName')}</SortMenuItem>
              <SortMenuItem active={fileSortMode === 'modified'} onClick={() => { setFileSortMode('modified'); setSortMenuOpen(false); }}>{t('recentlyModified')}</SortMenuItem>
              <SortMenuItem active={fileSortMode === 'name'} onClick={() => { setFileSortMode('name'); setSortMenuOpen(false); }}>{t('nameAz')}</SortMenuItem>
              {!isMobile && <SortMenuItem active={fileSortMode === 'type'} onClick={() => setFileSortMode('type')}>{t('byType')}</SortMenuItem>}
            </div>
          )}
        </div>

        {/* Show hidden toggle */}
        <button
          onClick={handleToggleHidden}
          className={`${iconBtnClass} ${showHidden ? '!text-primary-400' : ''}`}
          title={showHidden ? t('hideDotfiles') : t('showDotfiles')}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {showHidden ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
            )}
          </svg>
        </button>

        {/* Select mode toggle */}
        <SelectModeToggle />
        {/* Refresh */}
        <button onClick={() => onRefresh()} className={iconBtnClass} title={t('refreshAll')}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

    </div>
  );
}

/** Bottom drop zone for Files tab — drop files here or click to upload */
function FilesDropZone({ projects, onRefresh }: {
  projects: { id: string; name: string; rootPath?: string | null; color?: string }[];
  onRefresh: (path?: string) => void;
}) {
  const { t } = useTranslation('layout');
  const [dragOver, setDragOver] = useState(false);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<{ file: File; relativePath: string }[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const bumpRefreshTrigger = useFileStore((s) => s.bumpRefreshTrigger);

  const projectsWithPath = projects.filter(p => p.rootPath);

  // Close picker on outside click
  useEffect(() => {
    if (!showProjectPicker) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowProjectPicker(false);
        setPendingFiles(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showProjectPicker]);

  const uploadToProject = async (
    targetDir: string,
    items: { file: File; relativePath: string }[],
  ) => {
    if (items.length === 0) return;
    try {
      const { ok, fail } = await uploadDroppedFiles(targetDir, items);
      notifyUploadResult({ ok, fail });
      bumpRefreshTrigger();
    } catch (err) {
      emitProductNotice({ code: 'sidebar.upload.failed', technicalDetail: err });
    }
    setShowProjectPicker(false);
    setPendingFiles(null);
  };

  const handleItemsReady = (items: { file: File; relativePath: string }[]) => {
    if (items.length === 0) return;
    if (projectsWithPath.length === 1) {
      // Only one project — upload directly
      uploadToProject(projectsWithPath[0].rootPath!, items);
    } else if (projectsWithPath.length > 1) {
      // Multiple projects — show picker
      setPendingFiles(items);
      setShowProjectPicker(true);
    } else {
      toastError('No project folder available');
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer.getData('application/x-attachment')) return;
    let items;
    try {
      items = await readDroppedItems(e.dataTransfer);
    } catch (err) {
      console.error('[FilesDropZone] Failed to read dropped items:', err);
      toastError('Failed to read dropped folder');
      return;
    }
    if (items.length === 0) return;
    handleItemsReady(items);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    // <input type="file"> doesn't expose folder structure here — flat upload
    const items = Array.from(files).map((f) => ({ file: f, relativePath: f.name }));
    handleItemsReady(items);
    e.target.value = '';
  };

  return (
    <div className="relative px-1 pb-2 pt-1 shrink-0">
      <div
        className={`border-2 border-dashed rounded-lg py-3 text-center cursor-pointer transition-all ${
          dragOver
            ? 'border-primary-500/60 bg-primary-900/10 text-primary-400'
            : 'border-surface-700/50 text-surface-600 hover:border-surface-600 hover:text-surface-500'
        }`}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(true); }}
        onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
        onDrop={handleDrop}
      >
        <svg className="w-5 h-5 mx-auto mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
        </svg>
        <p className="text-[13px]">{t('dropFilesOrClick')}</p>
      </div>
      <input ref={fileInputRef} type="file" multiple hidden onChange={handleInputChange} />

      {/* Project picker popup — shown when multiple projects exist */}
      {showProjectPicker && pendingFiles && (
        <div ref={pickerRef} className="absolute bottom-full left-1 right-1 mb-1 bg-surface-800 border border-surface-700 rounded-lg shadow-xl py-1 z-50">
          <div className="px-3 py-1.5 text-[12px] text-gray-500 font-medium">{t('uploadTo')}</div>
          {projectsWithPath.map(p => (
            <button
              key={p.id}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[14px] text-gray-300 hover:bg-primary-600/30 hover:text-white transition-colors"
              onClick={() => uploadToProject(p.rootPath!, pendingFiles)}
            >
              <svg className="w-3.5 h-3.5 text-yellow-400/70" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
              </svg>
              {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** File tree toolbar: new file, new folder, upload, refresh, show hidden */
function FileTreeToolbar({ treeRoot, onRefresh }: { treeRoot: string; onRefresh: () => void }) {
  const { t } = useTranslation('layout');
  const [showInput, setShowInput] = useState<'file' | 'folder' | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const showHidden = useFileStore((s) => s.showHidden);
  const toggleShowHidden = useFileStore((s) => s.toggleShowHidden);

  useEffect(() => {
    if (showInput) inputRef.current?.focus();
  }, [showInput]);

  const getAuthHeaders = (): Record<string, string> => {
    const token = localStorage.getItem('token');
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  };

  const handleSubmit = async (value: string) => {
    if (!value.trim()) { setShowInput(null); return; }
    const endpoint = showInput === 'folder' ? '/api/files/mkdir' : '/api/files/create';
    const fullPath = `${treeRoot}/${value.trim()}`;
    try {
      const res = await fetch(endpoint, { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ path: fullPath }) });
      const data = await res.json();
      if (!res.ok) { emitProductNotice({ code: 'sidebar.file.create.failed', technicalDetail: data.error, context: { status: res.status } }); return; }
      toastSuccess(`${value.trim()} created`);
      onRefresh();
    } catch { toastError('Creation failed'); }
    setShowInput(null);
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const formData = new FormData();
    formData.append('targetDir', treeRoot);
    for (const file of Array.from(files)) formData.append('files', file);
    try {
      const token = localStorage.getItem('token');
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('/api/files/upload', { method: 'POST', headers, body: formData });
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) { toastError(`Upload failed (${res.status}): server returned non-JSON response`); return; }
      const data = await res.json();
      if (!res.ok) { emitProductNotice({ code: 'sidebar.upload.failed', technicalDetail: data.error, context: { status: res.status } }); return; }
      const ok = data.results.filter((r: { error?: string }) => !r.error);
      const fail = data.results.filter((r: { error?: string }) => r.error);
      notifyUploadResult({ ok: ok.length, fail: fail.length });
      onRefresh();
    } catch (err) {
      console.error('[toolbar] File upload error:', err);
      emitProductNotice({ code: 'sidebar.upload.failed', technicalDetail: err });
    }
    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  if (!treeRoot) return null;

  const btnClass = 'p-1 rounded text-surface-600 hover:text-primary-400 hover:bg-surface-800 transition-colors';

  return (
    <div className="px-1 pt-1">
      <div className="flex items-center gap-0.5">
        <button onClick={() => setShowInput(showInput === 'file' ? null : 'file')} className={btnClass} title={t('newFile')}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </button>
        <button onClick={() => setShowInput(showInput === 'folder' ? null : 'folder')} className={btnClass} title={t('newFolder')}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
          </svg>
        </button>
        <button onClick={() => fileInputRef.current?.click()} className={btnClass} title={t('uploadFiles')}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
        </button>
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleUpload} />
        <div className="flex-1" />
        <button
          onClick={() => { toggleShowHidden(); onRefresh(); }}
          className={`${btnClass} ${showHidden ? 'text-primary-400' : ''}`}
          title={showHidden ? t('hideDotfiles') : t('showDotfiles')}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {showHidden ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
            )}
          </svg>
        </button>
        <button onClick={onRefresh} className={btnClass} title={t('refresh')}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>
      {showInput && (
        <div className="mt-1 px-0.5">
          <input
            ref={inputRef}
            type="text"
            placeholder={showInput === 'file' ? t('enterFileName') : t('enterFolderName')}
            className="w-full bg-surface-950 border border-primary-500/50 rounded px-2 py-1 text-[13px] text-gray-200 outline-none placeholder-surface-700"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmit((e.target as HTMLInputElement).value);
              if (e.key === 'Escape') setShowInput(null);
            }}
            onBlur={() => setShowInput(null)}
          />
        </div>
      )}
    </div>
  );
}

/** Inline CWD picker for the project header */
function SidebarCwdPicker({ currentCwd, sessionId, onClose, onRequestFileTree }: {
  currentCwd: string;
  sessionId: string;
  onClose: () => void;
  onRequestFileTree: (path?: string) => void;
}) {
  const { t } = useTranslation('layout');
  const [browsePath, setBrowsePath] = useState(currentCwd);
  const [dirs, setDirs] = useState<{ name: string; path: string }[]>([]);
  const [inputValue, setInputValue] = useState(currentCwd);
  const [loading, setLoading] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const sessions = useSessionStore((s) => s.sessions);

  const recentCwds = Array.from(new Set(sessions.map((s) => s.cwd).filter(Boolean)))
    .filter((c) => c !== currentCwd)
    .slice(0, 5);

  useEffect(() => {
    setLoading(true);
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    fetch(`/api/directories?path=${encodeURIComponent(browsePath)}`, { headers })
      .then((r) => r.ok ? r.json() : { entries: [] })
      .then((data) => setDirs(data.entries || []))
      .catch(() => setDirs([]))
      .finally(() => setLoading(false));
  }, [browsePath]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const selectCwd = async (newCwd: string) => {
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ cwd: newCwd }),
      });
      if (res.ok) {
        useSessionStore.getState().updateSessionMeta(sessionId, { cwd: newCwd });
        onRequestFileTree();
        onClose();
      } else {
        const err = await res.json();
        emitProductNotice({ code: 'sidebar.cwd.change.failed', technicalDetail: err.error, context: { status: res.status } });
      }
    } catch {
      toastError('Failed to change CWD');
    }
  };

  const goUp = () => {
    const parent = browsePath.replace(/\/[^/]+\/?$/, '') || '/';
    setBrowsePath(parent);
    setInputValue(parent);
  };

  const handleInputSubmit = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      selectCwd(inputValue.trim());
    }
  };

  return (
    <div ref={pickerRef} className="absolute top-full left-0 right-0 mt-1 mx-2 bg-surface-900 border border-surface-700 rounded-lg shadow-2xl z-50 overflow-hidden">
      {/* Manual input */}
      <div className="p-2 border-b border-surface-800">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleInputSubmit}
          className="w-full bg-surface-950 border border-surface-700 rounded-md px-3 py-1.5 text-[14px] text-gray-200 font-mono focus:outline-none focus:border-primary-500/50"
          placeholder={t('enterPathHint')}
        />
      </div>

      {/* Recent cwds */}
      {recentCwds.length > 0 && (
        <div className="px-2 py-1.5 border-b border-surface-800">
          <div className="text-[12px] text-gray-500 uppercase tracking-wider mb-1 px-1">{t('recent')}</div>
          {recentCwds.map((c) => (
            <button
              key={c}
              onClick={() => selectCwd(c)}
              className="w-full text-left px-2 py-1 rounded text-[13px] text-gray-400 hover:bg-surface-800 hover:text-gray-200 truncate font-mono"
            >
              {c.replace(/^\/home\/[^/]+/, '~')}
            </button>
          ))}
        </div>
      )}

      {/* Directory browser */}
      <div className="max-h-48 overflow-y-auto">
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-surface-800">
          <button
            onClick={goUp}
            disabled={browsePath === '/'}
            className="p-1 rounded hover:bg-surface-800 text-gray-400 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed"
            title={t('parentDirectory')}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" /></svg>
          </button>
          <span className="text-[13px] text-gray-500 font-mono truncate flex-1">{browsePath.replace(/^\/home\/[^/]+/, '~')}</span>
          <button
            onClick={() => selectCwd(browsePath)}
            className="text-[12px] px-2 py-0.5 rounded bg-primary-600/20 border border-primary-500/30 text-primary-300 hover:bg-primary-600/30"
          >
            Select
          </button>
        </div>
        {loading ? (
          <div className="py-4 text-center text-[13px] text-gray-500">{t('common:loading')}</div>
        ) : dirs.length === 0 ? (
          <div className="py-4 text-center text-[13px] text-gray-500">{t('noSubdirectories')}</div>
        ) : (
          dirs.map((d) => (
            <button
              key={d.path}
              onClick={() => { setBrowsePath(d.path); setInputValue(d.path); }}
              onDoubleClick={() => selectCwd(d.path)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-800/60 transition-colors"
            >
              <svg className="w-3.5 h-3.5 text-yellow-500/60 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" /></svg>
              <span className="text-[13px] text-gray-300 truncate">{d.name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/* ── Ungrouped Drop Zone ── */

function UngroupedDropZone({ children, onMoveSession, hasGroups, hasUngrouped }: {
  children: React.ReactNode;
  onMoveSession: (sessionId: string, projectId: string | null) => void;
  hasGroups: boolean;
  hasUngrouped: boolean;
}) {
  const { t } = useTranslation('layout');
  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      className={`mt-2 rounded-md transition-colors ${dragOver ? 'bg-surface-800/50 ring-1 ring-surface-700/50' : ''} ${!hasUngrouped && hasGroups ? 'min-h-[40px] flex items-center justify-center' : ''}`}
      // HTML5 dragleave는 자식 요소로 커서가 진입할 때도 부모에 버블되어 flicker를 유발.
      // dragenter에서만 켜고, contains 체크로 진짜 나갔을 때만 끈다.
      onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const sessionId = e.dataTransfer.getData('text/plain');
        if (sessionId) onMoveSession(sessionId, null);
      }}
    >
      {!hasUngrouped && dragOver && (
        <span className="text-[12px] text-surface-500">{t('dropToRemoveFromProject')}</span>
      )}
      {children}
    </div>
  );
}

/* ── Project Group ── */

const PROJECT_PREVIEW_MIN = 3;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Parse date string to UTC ms (cached per string to avoid repeated parsing) */
const _tsCache = new Map<string, number>();
function parseTs(dateStr: string): number {
  let v = _tsCache.get(dateStr);
  if (v !== undefined) return v;
  let d = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T');
  if (!d.endsWith('Z') && !/[+-]\d{2}(:\d{2})?$/.test(d)) d += 'Z';
  v = new Date(d).getTime();
  _tsCache.set(dateStr, v);
  if (_tsCache.size > 2000) _tsCache.clear(); // prevent unbounded growth
  return v;
}

/** Preview count: at least 3, plus any sessions updated within the last 24h */
function getPreviewCount(sessions: SessionMeta[]): number {
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  let count = 0;
  for (const s of sessions) {
    if (parseTs(s.updatedAt) >= cutoff) count++;
  }
  return Math.max(PROJECT_PREVIEW_MIN, count);
}

function ProjectGroup({
  project, sessions: groupSessions, collapsed, activeSessionId,
  onToggleCollapsed, onSelectSession, onDeleteSession, onRenameSession,
  onToggleFavorite, onNewSession, onMoveSession, projects, currentUsername,
  hasActivity, myUnreadCount, showLabels = true,
}: {
  project: Project;
  sessions: SessionMeta[];
  collapsed: boolean;
  activeSessionId: string | null;
  hasActivity: boolean;
  myUnreadCount: number;
  onToggleCollapsed: () => void;
  onSelectSession: (s: SessionMeta) => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
  onToggleFavorite: (id: string, fav: boolean) => void;
  // When user hits "+" on a deck header inside this project, label is forwarded
  // so the new session is created pre-tagged into that deck.
  onNewSession: (label?: string) => void;
  onMoveSession: (sessionId: string, projectId: string | null) => void;
  projects: Project[];
  currentUsername?: string;
  showLabels?: boolean;
}) {
  const { t } = useTranslation('layout');
  const agentFirstEnabled = useSettingsStore((s) => s.serverConfig?.agentFirstEnabled === true);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [agentSessionPreviewLimit, setAgentSessionPreviewLimit] = useState<20 | 50>(() => getAgentSessionPreviewLimit());
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(project.name);
  const [dragOver, setDragOver] = useState(false);
  const showAllKey = `project::${project.id}`;
  const [expanded, setExpanded] = useState(() => isSessionShowAllExpanded(showAllKey));
  const [visibleLimit, setVisibleLimit] = useState(() => getInitialSessionVisibleLimit(showAllKey));
  const toggleExpanded = useCallback((total?: number, previewCount?: number) => {
    setExpanded((prev) => {
      if (prev) {
        clearSessionStoredVisibleCount(showAllKey);
        setVisibleLimit(SESSION_INITIAL_EXPANDED_LIMIT);
        return false;
      }
      const nextLimit = getNextSessionVisibleLimit(total ?? groupSessions.length, previewCount ?? getPreviewCount(groupSessions), false, visibleLimit);
      setSessionStoredVisibleCount(showAllKey, nextLimit);
      setVisibleLimit(nextLimit);
      return true;
    });
  }, [groupSessions, showAllKey, visibleLimit]);
  const showMoreSessions = useCallback((total: number, previewCount: number) => {
    setExpanded(true);
    setVisibleLimit((prev) => {
      const next = getNextSessionVisibleLimit(total, previewCount, expanded, prev);
      setSessionStoredVisibleCount(showAllKey, next);
      return next;
    });
  }, [expanded, showAllKey]);
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handlePreviewLimitUpdated = (event: Event) => {
      const limit = (event as CustomEvent<{ limit?: number }>).detail?.limit;
      if (limit === 20 || limit === 50) setAgentSessionPreviewLimit(limit);
    };
    window.addEventListener('tower:agent-session-preview-limit-updated', handlePreviewLimitUpdated);
    return () => window.removeEventListener('tower:agent-session-preview-limit-updated', handlePreviewLimitUpdated);
  }, []);

  // Label collapse state — subscribed via hook so toggle triggers re-render immediately
  const collapsedLabels = useProjectStore((s) => s.collapsedLabels);
  const toggleLabelCollapsed = useProjectStore((s) => s.toggleLabelCollapsed);
  const pinProject = useProjectStore((s) => s.pinProject);
  const unpinProject = useProjectStore((s) => s.unpinProject);
  const movePinnedProject = useProjectStore((s) => s.movePinnedProject);

  // Activity/unread are computed in Sidebar and passed as scalars. Avoid one
  // streaming/unread store subscription per project group; during AI streaming
  // those Set references are hot and otherwise wake every group independently.
  const hasUnread = myUnreadCount > 0;
  const projectNameTone = hasUnread || hasActivity ? 'font-bold' : 'font-bold';
  const projectNameColor = hasUnread || hasActivity ? 'var(--th-text-primary)' : 'var(--th-text-secondary)';

  useEffect(() => {
    if (editing) editRef.current?.focus();
  }, [editing]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const sessionId = e.dataTransfer.getData('text/plain');
    if (sessionId) onMoveSession(sessionId, project.id);
  };

  const commitRename = async () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== project.name) {
      const token = localStorage.getItem('token');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      try {
        const res = await fetch(`/api/projects/${project.id}`, {
          method: 'PATCH', headers, body: JSON.stringify({ name: trimmed }),
        });
        if (res.ok) {
          const updated = await res.json();
          // Sync display-name changes. Project rootPath intentionally stays stable.
          useProjectStore.getState().updateProject(project.id, updated);
        }
      } catch {}
    }
    setEditing(false);
  };

  const handleDelete = async () => {
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
      const res = await fetch(`/api/projects/${project.id}/retire`, { method: 'POST', headers });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        emitProductNotice({ code: 'sidebar.project.delete.failed', technicalDetail: data.error, context: { status: res.status } });
        return;
      }
      useProjectStore.getState().removeProject(project.id);
      // Locally clear projectId on affected sessions
      for (const s of groupSessions) {
        useSessionStore.getState().updateSessionMeta(s.id, { projectId: null });
      }
      // Remove archived channels from room store
      const rooms = useRoomStore.getState().rooms.filter(r => r.projectId === project.id);
      for (const r of rooms) {
        useRoomStore.getState().removeRoom(r.id);
      }
      toastSuccess(`Project "${project.name}" deleted`);
    } catch (error) {
      emitProductNotice({ code: 'sidebar.project.delete.failed', technicalDetail: error });
    }
  };


  return (
    <div className="mb-0">
      {/* Group header — also a drop zone */}
      <div
        className={`flex min-h-10 min-w-0 items-center gap-1 rounded-lg py-1 pl-0.5 pr-0 cursor-pointer transition-colors group/proj ${
          dragOver ? 'bg-primary-600/20 ring-1 ring-primary-500/40' : 'hover:bg-surface-800/70'
        }`}
        onClick={onToggleCollapsed}
        onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
        // Rename stays in the right-click context menu only. Double-clicking a
        // project header is too easy to trigger accidentally while expanding.
        // dragenter + contains-check로 자식 진입 시의 flicker 방지
        onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
        onDrop={handleDrop}
      >
        {/* In Agent-first, chevron/avatar/name share one expand contract. Home navigation stays explicit. */}
        <button type="button" onClick={(event) => { event.stopPropagation(); onToggleCollapsed(); }} className="grid h-6 w-6 shrink-0 place-items-center rounded hover:bg-surface-700/50" aria-label={collapsed ? t('expandAiTeammate') : t('collapseAiTeammate')}>
          {hasActivity ? (
            <RunIndicator size="xs" label={t('workspaceHasRunningSessions')} className="tone-success tone-text shrink-0" />
          ) : (
            <svg className={`w-3.5 h-3.5 text-surface-600 group-hover/proj:text-surface-300 max-[768px]:text-gray-500 transition-all shrink-0 ${collapsed ? '-rotate-90' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          )}
        </button>
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              ref={editRef}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditing(false); }}
              onClick={(e) => e.stopPropagation()}
              className="w-full h-[22px] bg-surface-700 text-gray-100 text-sidebar-project-size px-1 rounded border border-surface-600 outline-none focus:border-primary-500"
            />
          ) : (
            <div className="flex min-h-8 min-w-0 items-center gap-1">
              {agentFirstEnabled && <button type="button" className="mr-2 shrink-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/70" onClick={(event) => { event.stopPropagation(); onToggleCollapsed(); }} aria-label={collapsed ? t('expandNamedConversations', { name: project.agent?.displayName || project.name }) : t('collapseNamedConversations', { name: project.agent?.displayName || project.name })}><AgentIdentityAvatar project={project} variant="list" showListAccent={false} className="h-6 w-6 max-[768px]:h-9 max-[768px]:w-9 shrink-0 rounded-lg" fallbackClassName="grid h-6 w-6 max-[768px]:h-9 max-[768px]:w-9 shrink-0 place-items-center rounded-lg bg-surface-800 text-[10px]" /></button>}
              <button
                type="button"
                onClick={(event) => {
                  if (!agentFirstEnabled) return;
                  event.stopPropagation();
                  onToggleCollapsed();
                }}
                className={`min-h-8 min-w-0 flex-1 truncate text-left text-[14px] font-semibold leading-8 tracking-[-0.01em] ${projectNameTone} ${agentFirstEnabled ? 'hover:text-primary-300' : ''}`}
                style={{ color: projectNameColor }}
                title={agentFirstEnabled ? (collapsed ? t('expandConversations') : t('collapseConversations')) : project.name}
                aria-expanded={agentFirstEnabled ? !collapsed : undefined}
              >
                {agentFirstEnabled ? (project.agent?.displayName || project.name) : project.name}
              </button>
              <div className="ml-auto flex shrink-0 items-center gap-0.5">
              {myUnreadCount > 0 ? (
                <span className="tone-pill tone-success mr-0.5 shrink-0 rounded px-1 py-0.5 text-[11px] font-semibold leading-none">
                  {myUnreadCount}
                </span>
              ) : (
                <span className="mr-0.5 shrink-0 text-[13px] tabular-nums text-surface-600">
                  {groupSessions.length}
                </span>
              )}
              {agentFirstEnabled && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    rememberAgentWorkspaceLocation(project.id, 'home');
                    useFileStore.getState().openSystemTab('projectFiles', { refId: project.id, title: t('agentHomeTabTitle', { name: project.agent?.displayName || project.name }), icon: project.agent?.face || '✨' });
                    useSessionStore.getState().setActiveView('chat');
                    if (useSessionStore.getState().isMobile) useSessionStore.getState().setSidebarOpen(false);
                  }}
                  className="hidden h-7 w-7 shrink-0 place-items-center rounded-md text-surface-500 transition-colors hover:bg-surface-700/50 hover:text-primary-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/70 min-[769px]:grid"
                  aria-label={t('openNamedHome', { name: project.agent?.displayName || project.name })}
                  title={t('namedHome', { name: project.agent?.displayName || project.name })}
                >
                  <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 10.5 12 3.75l8.25 6.75M5.25 9.75v9a1.5 1.5 0 0 0 1.5 1.5h3.5v-5.5h3.5v5.5h3.5a1.5 1.5 0 0 0 1.5-1.5v-9" />
                  </svg>
                </button>
              )}
              {/* Keep the compact + affordance on desktop. Mobile gets a labeled action below the expanded teammate row. */}
              <button
                onClick={(e) => { e.stopPropagation(); onNewSession(); }}
                className="hidden h-7 w-7 shrink-0 place-items-center rounded-md text-surface-500 transition-colors hover:bg-surface-700/50 hover:text-primary-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/70 min-[769px]:grid"
                aria-label={t('startNewConversationWith', { name: project.agent?.displayName || project.name })}
                title={t('newSession')}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
              </button>
              {/* 3-dot menu — hidden by default, shown on hover */}
              <button
                onClick={(e) => { e.stopPropagation(); setCtxMenu({ x: e.currentTarget.getBoundingClientRect().right, y: e.currentTarget.getBoundingClientRect().bottom + 4 }); }}
                className="shrink-0 rounded p-0.5 text-surface-600 transition-all hover:bg-surface-700/50 hover:text-gray-300 min-[769px]:hidden"
                aria-label={t('projectActions')}
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <circle cx="12" cy="5" r="1.5" />
                  <circle cx="12" cy="12" r="1.5" />
                  <circle cx="12" cy="19" r="1.5" />
                </svg>
              </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {!collapsed && agentFirstEnabled && (
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); onNewSession(); }}
          className="mx-2 mb-1 hidden min-h-9 items-center justify-center gap-1.5 rounded-lg border border-surface-700/70 bg-surface-900/55 px-3 text-[13px] font-semibold text-primary-700 transition-colors hover:border-primary-500/50 hover:bg-primary-500/10 hover:text-primary-800 dark:text-primary-300 dark:hover:text-primary-200 max-[768px]:flex"
          aria-label={t('startNewConversationWith', { name: project.agent?.displayName || project.name })}
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          {t('newChat')}
        </button>
      )}

      {/* Sessions inside group — sub-grouped by label */}
      {!collapsed && (() => {
        // Group sessions by label
        const labelGroups = new Map<string, SessionMeta[]>();
        const unlabeled: SessionMeta[] = [];
        for (const s of groupSessions) {
          if (s.label) {
            const list = labelGroups.get(s.label) || [];
            list.push(s);
            labelGroups.set(s.label, list);
          } else {
            unlabeled.push(s);
          }
        }

        // Sort label groups by most recent session activity
        const sortedLabels = [...labelGroups.entries()].sort((a, b) => {
          const latestA = Math.max(...a[1].map(s => new Date(s.updatedAt.includes('T') ? s.updatedAt : s.updatedAt.replace(' ', 'T') + 'Z').getTime()));
          const latestB = Math.max(...b[1].map(s => new Date(s.updatedAt.includes('T') ? s.updatedAt : s.updatedAt.replace(' ', 'T') + 'Z').getTime()));
          return latestB - latestA;
        });

        const toggleLabel = toggleLabelCollapsed;

        // Helper: apply label to a session via D&D (optimistic + background persist)
        const applyLabelToSession = (sessionId: string, label: string | null) => {
          useSessionStore.getState().updateSessionMeta(sessionId, { label });
          const token = localStorage.getItem('token');
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (token) headers['Authorization'] = `Bearer ${token}`;
          fetch(`/api/sessions/${sessionId}`, {
            method: 'PATCH', headers, body: JSON.stringify({ label }),
          }).catch(() => {});
        };

        // Only the explicit deck-filter toggle flattens sessions. When every
        // session is unlabeled, keep the synthetic Uncategorized group visible.
        if (!showLabels) {
          const previewCount = agentFirstEnabled
            ? Math.min(groupSessions.length, agentSessionPreviewLimit)
            : getPreviewCount(groupSessions);
          const displayedCount = getSessionDisplayCount(groupSessions.length, previewCount, expanded, visibleLimit);
          const visibleSessions = groupSessions.slice(0, displayedCount);
          const hasMore = groupSessions.length > previewCount;
          const remainingCount = groupSessions.length - displayedCount;
          const nextBatchCount = getNextSessionBatchCount(groupSessions.length, previewCount, expanded, visibleLimit);
          return (
            <div className="ml-2.5 pl-3 border-l border-surface-700/25 space-y-0.5">
              {visibleSessions.map((session) => (
                <SessionItem key={session.id} session={session} isActive={session.id === activeSessionId} currentUsername={currentUsername} onSelect={onSelectSession} onDelete={onDeleteSession} onRename={onRenameSession} onToggleFavorite={onToggleFavorite} onMoveToProject={onMoveSession} projects={projects} />
              ))}
              {hasMore && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    remainingCount > 0
                      ? showMoreSessions(groupSessions.length, previewCount)
                      : toggleExpanded(groupSessions.length, previewCount);
                  }}
                  data-sidebar-session-showall-project={remainingCount > 0 ? project.id : undefined}
                  className="w-full text-left text-[13px] text-surface-500 hover:text-gray-300 py-1 px-2 rounded hover:bg-surface-800/50 transition-colors"
                >
                  {remainingCount > 0
                    ? t('showMoreSessions', { count: nextBatchCount, remaining: remainingCount })
                    : t('showLess')}
                </button>
              )}
            </div>
          );
        }

        // Render label sub-groups + unlabeled
        const renderProjectLabelGroup = (label: string, sessions: SessionMeta[]) => {
          const labelKey = `${project.id}::${label}`;
          const isLabelCollapsed = collapsedLabels.has(labelKey);
          return (
            <LabelGroup
              key={label}
              label={label}
              sessions={sessions}
              projectId={project.id}
              isCollapsed={isLabelCollapsed}
              onToggle={() => toggleLabel(project.id, label)}
              onDropSession={(sessionId) => applyLabelToSession(sessionId, label)}
              activeSessionId={activeSessionId}
              currentUsername={currentUsername}
              onSelectSession={onSelectSession}
              onDeleteSession={onDeleteSession}
              onRenameSession={onRenameSession}
              onToggleFavorite={onToggleFavorite}
              onMoveSession={onMoveSession}
              projects={projects}
              onNewSession={() => onNewSession(label)}
            />
          );
        };
        return (
          <div className="ml-2.5 pl-3 border-l border-surface-700/25 space-y-0.5">
            {sortedLabels.map(([label, sessions]) => renderProjectLabelGroup(label, sessions))}
            {/* No-deck sessions stay discoverable in one synthetic Uncategorized group. */}
            {unlabeled.length > 0 && (
              <LabelGroup
                key={`${project.id}:__uncategorized__`}
                label="temp"
                sessions={unlabeled}
                projectId={project.id}
                isCollapsed={collapsedLabels.has(`${project.id}::__uncategorized__`)}
                onToggle={() => toggleLabel(project.id, '__uncategorized__')}
                onDropSession={(sessionId) => applyLabelToSession(sessionId, null)}
                activeSessionId={activeSessionId}
                currentUsername={currentUsername}
                onSelectSession={onSelectSession}
                onDeleteSession={onDeleteSession}
                onRenameSession={onRenameSession}
                onToggleFavorite={onToggleFavorite}
                onMoveSession={onMoveSession}
                projects={projects}
                onNewSession={() => onNewSession()}
                isSystemGroup
              />
            )}
          </div>
        );
      })()}

      {/* Context menu */}
      {ctxMenu && (
        <ProjectContextMenu
          x={ctxMenu.x} y={ctxMenu.y}
          project={project}
          onRename={() => { setEditing(true); setEditName(project.name); }}
          onDelete={handleDelete}
          onClose={() => setCtxMenu(null)}
          onNewChat={onNewSession}
          onOpenHome={() => {
            rememberAgentWorkspaceLocation(project.id, 'home');
            useFileStore.getState().openSystemTab('projectFiles', { refId: project.id, title: t('agentHomeTabTitle', { name: project.agent?.displayName || project.name }), icon: project.agent?.face || '✨' });
            useSessionStore.getState().setActiveView('chat');
            if (useSessionStore.getState().isMobile) useSessionStore.getState().setSidebarOpen(false);
          }}
          sessionCount={groupSessions.length}
          previewCount={agentFirstEnabled ? Math.min(groupSessions.length, agentSessionPreviewLimit) : getPreviewCount(groupSessions)}
          expanded={expanded}
          onToggleExpanded={() => toggleExpanded(groupSessions.length, agentFirstEnabled ? Math.min(groupSessions.length, agentSessionPreviewLimit) : getPreviewCount(groupSessions))}
          agentSessionPreviewLimit={agentSessionPreviewLimit}
          onChangeAgentSessionPreviewLimit={(limit) => {
            saveAgentSessionPreviewLimit(limit);
            setAgentSessionPreviewLimit(limit);
            clearSessionStoredVisibleCount(showAllKey);
            setExpanded(false);
            setVisibleLimit(limit);
          }}
          showAgentSessionLimitOptions={agentFirstEnabled}
          isPinned={project.pinned === true}
          onTogglePin={() => project.pinned ? unpinProject(project.id) : pinProject(project.id)}
          onMovePinUp={() => movePinnedProject(project.id, 'up')}
          onMovePinDown={() => movePinnedProject(project.id, 'down')}
        />
      )}
    </div>
  );
}

/* ── Project Context Menu ── */

function ProjectContextMenu({
  x, y, project, onRename, onDelete, onClose, onNewChat, onOpenHome,
  sessionCount, previewCount, expanded, onToggleExpanded,
  agentSessionPreviewLimit, onChangeAgentSessionPreviewLimit, showAgentSessionLimitOptions,
  isPinned, onTogglePin, onMovePinUp, onMovePinDown, showPinControls = true,
}: {
  x: number; y: number; project: Project;
  onRename: () => void; onDelete: () => void;
  onClose: () => void;
  onNewChat: () => void;
  onOpenHome: () => void;
  sessionCount: number;
  previewCount: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  agentSessionPreviewLimit: 20 | 50;
  onChangeAgentSessionPreviewLimit: (limit: 20 | 50) => void;
  showAgentSessionLimitOptions: boolean;
  isPinned: boolean;
  onTogglePin: () => void;
  onMovePinUp: () => void;
  onMovePinDown: () => void;
  showPinControls?: boolean;
}) {
  const { t } = useTranslation('layout');
  const confirm = useConfirm();
  const ref = useRef<HTMLDivElement>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showCredentials, setShowCredentials] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showManageDecks, setShowManageDecks] = useState(false);
  const [inviteQuery, setInviteQuery] = useState('');
  const [allUsers, setAllUsers] = useState<{ id: number; username: string }[]>([]);
  const [currentMembers, setCurrentMembers] = useState<{ userId: number; username: string; role: string }[]>([]);
  const inviteInputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [adjustedPos, setAdjustedPos] = useState({ left: x, top: y });

  // Adjust position to stay within viewport.
  // Re-runs when the panel switches mode (showInvite/Settings/ManageDecks change height)
  // AND watches size changes via ResizeObserver — the invite panel grows asynchronously
  // as /api/users/search and /api/projects/:id/members resolve, so a one-shot measurement
  // would leave the popover clipped at the bottom of the viewport.
  useLayoutEffect(() => {
    let frame = 0;
    const adjust = () => {
      if (!ref.current) return;
      const rect = ref.current.getBoundingClientRect();
      const pad = 8;
      // Compute from the original click anchor (x/y), not from the current
      // adjusted rect. Otherwise a menu near the viewport edge can bounce
      // between anchor and adjusted positions as ResizeObserver fires after
      // each state-driven layout change.
      const anchoredBottom = y + rect.height;
      const anchoredRight = x + rect.width;
      const newTop = anchoredBottom > window.innerHeight - pad
        ? Math.max(pad, window.innerHeight - rect.height - pad) : y;
      const newLeft = anchoredRight > window.innerWidth - pad
        ? Math.max(pad, window.innerWidth - rect.width - pad) : x;
      setAdjustedPos(prev =>
        prev.left === newLeft && prev.top === newTop ? prev : { left: newLeft, top: newTop }
      );
    };
    const scheduleAdjust = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        adjust();
      });
    };
    adjust();
    if (!ref.current) return;
    const observer = new ResizeObserver(scheduleAdjust);
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [x, y, showInvite, showSettings, showCredentials, showManageDecks]);

  useEffect(() => {
    const menu = ref.current;
    const focusable = () => Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled])') ?? []);
    window.requestAnimationFrame(() => focusable()[0]?.focus());
    const closeAndRestoreFocus = () => {
      onClose();
      window.requestAnimationFrame(() => previousFocusRef.current?.focus());
    };
    const handlePointerDown = (event: MouseEvent) => {
      if (menu && !menu.contains(event.target as Node)) closeAndRestoreFocus();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeAndRestoreFocus();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const items = focusable();
      if (items.length === 0) return;
      event.preventDefault();
      const currentIndex = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (currentIndex + 1) % items.length : (currentIndex - 1 + items.length) % items.length;
      items[nextIndex]?.focus();
    };
    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  // Fetch all users + current members when invite panel opens
  useEffect(() => {
    if (!showInvite) return;
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    // Fetch all users
    fetch('/api/users/search?q=', { headers })
      .then(r => r.ok ? r.json() : [])
      .then(setAllUsers)
      .catch(() => {});
    // Fetch current members
    fetch(`/api/projects/${project.id}/members`, { headers: { ...headers, 'Content-Type': 'application/json' } })
      .then(r => r.ok ? r.json() : [])
      .then(setCurrentMembers)
      .catch(() => {});
    setTimeout(() => inviteInputRef.current?.focus(), 50);
  }, [showInvite, project.id]);

  const handleInvite = async (userId: number) => {
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
      const res = await fetch(`/api/projects/${project.id}/members`, {
        method: 'POST', headers, body: JSON.stringify({ userId }),
      });
      if (res.ok) {
        const user = allUsers.find(u => u.id === userId);
        setCurrentMembers(prev => [...prev, { userId, username: user?.username || '', role: 'member' }]);
      }
    } catch {}
  };

  const handleRemoveMember = async (userId: number) => {
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
      const res = await fetch(`/api/projects/${project.id}/members/${userId}`, {
        method: 'DELETE', headers,
      });
      if (res.ok) {
        setCurrentMembers(prev => prev.filter(m => m.userId !== userId));
      }
    } catch {}
  };

  const memberIds = currentMembers.map(m => m.userId);
  const filteredUsers = allUsers.filter(u => {
    if (memberIds.includes(u.id)) return false;
    if (!inviteQuery.trim()) return true;
    return u.username.toLowerCase().includes(inviteQuery.toLowerCase());
  });

  const itemClass = "w-full flex items-center gap-2 px-3 py-2 text-[14px] text-gray-300 hover:bg-primary-600/30 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-400/70";

  if (showSettings) {
    return (
      <div ref={ref} className="fixed z-50" style={adjustedPos}>
        <ProjectSettingsPanel project={project} onClose={onClose} />
      </div>
    );
  }

  if (showCredentials) {
    return <AgentCredentialsModal project={project} onClose={onClose} />;
  }

  if (showManageDecks) {
    return (
      <div ref={ref} className="fixed z-50" style={adjustedPos}>
        <ManageDecksPanel projectId={project.id} onClose={onClose} />
      </div>
    );
  }

  if (showInvite) {
    return (
      <div ref={ref} className="fixed z-50 bg-surface-800 border border-surface-700 rounded-lg shadow-xl min-w-[220px]"
        style={adjustedPos}>
        <div className="px-3 py-2 border-b border-surface-700/50 flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-blue-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
          </svg>
          <input
            ref={inviteInputRef}
            value={inviteQuery}
            onChange={(e) => setInviteQuery(e.target.value)}
            placeholder={t('searchMembers')}
            className="flex-1 bg-transparent text-[14px] text-gray-200 placeholder-surface-600 outline-none"
          />
        </div>
        <div className="max-h-[200px] overflow-y-auto py-1">
          {filteredUsers.length === 0 ? (
            <div className="px-3 py-2 text-[13px] text-surface-600">
              {allUsers.length === 0 ? t('common:loading') : t('noUsersToInvite')}
            </div>
          ) : (
            filteredUsers.map(u => (
              <button
                key={u.id}
                onClick={() => handleInvite(u.id)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[14px] text-surface-300 hover:bg-primary-500/10 hover:text-primary-700 dark:hover:text-primary-100 transition-colors"
              >
                <span className="w-5 h-5 rounded-full bg-surface-700 flex items-center justify-center text-[11px] text-gray-400 shrink-0">
                  {u.username[0]?.toUpperCase()}
                </span>
                {u.username}
              </button>
            ))
          )}
        </div>
        {currentMembers.length > 0 && (
          <>
            <div className="px-3 py-1 border-t border-surface-700/50">
              <span className="text-[12px] text-surface-500 uppercase tracking-wider">{t('membersCount', { count: currentMembers.length })}</span>
            </div>
            <div className="max-h-[120px] overflow-y-auto py-1">
              {currentMembers.map(m => (
                <div key={m.userId} className="flex items-center gap-2 px-3 py-1 text-[14px] text-gray-400 group/member">
                  <span className="w-5 h-5 rounded-full bg-surface-700 flex items-center justify-center text-[11px] text-gray-400 shrink-0">
                    {m.username?.[0]?.toUpperCase() || '?'}
                  </span>
                  <span className="flex-1 truncate">{m.username || `User ${m.userId}`}</span>
                  <span className="text-[11px] text-surface-600">{m.role}</span>
                  {m.role !== 'owner' && (
                    <button
                      onClick={() => handleRemoveMember(m.userId)}
                      className="opacity-0 group-hover/member:opacity-100 text-red-400 hover:text-red-300 p-0.5 transition-opacity"
                      title={t('remove')}
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div ref={ref} role="menu" aria-label={t('projectActions')} className="fixed z-50 bg-surface-800 border border-surface-700 rounded-lg shadow-xl py-1 min-w-[160px]"
      style={adjustedPos}>
      {/* Agent Home */}
      <button role="menuitem" className={itemClass} onClick={() => { onOpenHome(); onClose(); }}>
        <svg className="h-3.5 w-3.5 text-primary-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 10.5 12 3.75l8.25 6.75M5.25 9.75v9a1.5 1.5 0 0 0 1.5 1.5h3.5v-5.5h3.5v5.5h3.5a1.5 1.5 0 0 0 1.5-1.5v-9" />
        </svg>
        {t('goToAgentHome')}
      </button>
      {/* New Chat */}
      <button role="menuitem" className={itemClass} onClick={() => { onNewChat(); onClose(); }}>
        <svg className="w-3.5 h-3.5 text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
        {t('newChat')}
      </button>
      {/* Personal pin remains available in the detailed project row menu, not the first-level AI rail. */}
      {showPinControls && (
        <button role="menuitem" className={itemClass} onClick={() => { onTogglePin(); onClose(); }}>
          <svg className="tone-warning tone-text w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M16 3.5v5.1l2.3 2.3c.45.45.13 1.2-.5 1.2h-4.55v7.15a.75.75 0 01-1.5 0V12.1H7.2c-.63 0-.95-.75-.5-1.2L9 8.6V3.5H7.75a.75.75 0 010-1.5h8.5a.75.75 0 010 1.5H16z" />
          </svg>
          {isPinned ? t('unpinProject') : t('pinProject')}
        </button>
      )}
      {showPinControls && isPinned && (
        <>
          <button role="menuitem" className={itemClass} onClick={() => { onMovePinUp(); onClose(); }}>
            <span className="w-3.5 text-center text-surface-400">↑</span>
            {t('movePinUp')}
          </button>
          <button role="menuitem" className={itemClass} onClick={() => { onMovePinDown(); onClose(); }}>
            <span className="w-3.5 text-center text-surface-400">↓</span>
            {t('movePinDown')}
          </button>
        </>
      )}
      {/* Show all / Show less */}
      {sessionCount > previewCount && (
        <button role="menuitem" className={itemClass} onClick={() => { onToggleExpanded(); onClose(); }}>
          <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
          {expanded ? t('showLess') : t('showAll', { count: sessionCount })}
        </button>
      )}
      {showAgentSessionLimitOptions && (
        <>
          <div className="border-t border-surface-700/50 my-1" />
          <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-surface-500">{t('defaultConversationDisplay')}</div>
          <button role="menuitemradio" aria-checked={agentSessionPreviewLimit === 20} className={itemClass} onClick={() => { onChangeAgentSessionPreviewLimit(20); onClose(); }}><span className="w-3.5 text-center text-primary-300">{agentSessionPreviewLimit === 20 ? '✓' : ''}</span>{t('showOnlyCount', { count: 20 })}</button>
          <button role="menuitemradio" aria-checked={agentSessionPreviewLimit === 50} className={itemClass} onClick={() => { onChangeAgentSessionPreviewLimit(50); onClose(); }}><span className="w-3.5 text-center text-primary-300">{agentSessionPreviewLimit === 50 ? '✓' : ''}</span>{t('showOnlyCount', { count: 50 })}</button>
        </>
      )}
      <div className="border-t border-surface-700/50 my-1" />
      {/* Invite Members */}
      <button role="menuitem" className={itemClass} onClick={() => setShowInvite(true)}>
        <svg className="w-3.5 h-3.5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
        </svg>
        {t('inviteMembersMenu')}
      </button>
      {/* Rename */}
      <button role="menuitem" className={itemClass} onClick={() => { onRename(); onClose(); }}>
        <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
        {t('common:rename')}
      </button>
      {/* Credential management */}
      <button role="menuitem" className={itemClass} onClick={() => setShowCredentials(true)}>
        <svg className="h-3.5 w-3.5 text-primary-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM5.25 21a6.75 6.75 0 0113.5 0M17.25 9.75l1.5 1.5 3-3" />
        </svg>
        {t('agentCredentials.title')}
      </button>
      {/* Settings */}
      <button role="menuitem" className={itemClass} onClick={() => setShowSettings(true)}>
        <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        {t('settings')}
      </button>
      {/* Manage Decks */}
      <button role="menuitem" className={itemClass} onClick={() => setShowManageDecks(true)}>
        <svg className="w-3.5 h-3.5 text-primary-500/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
        </svg>
        {t('manageDecks')}
      </button>
      <div className="border-t border-surface-700/50 my-1" />
      <button role="menuitem" className={`${itemClass} !text-red-400 hover:!bg-red-950/30`} onClick={async () => {
        const detail = sessionCount > 0 ? t('archiveAgentDetailWithCount', { count: sessionCount }) : t('archiveAgentDetail');
        const ok = await confirm({
          title: t('archiveAgentTitle', { name: project.name }),
          message: t('archiveAgentMessage', { detail }),
          confirmLabel: t('archiveAgentConfirm'),
          danger: true,
        });
        if (ok) { onDelete(); onClose(); }
      }}>
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
        {t('deleteProject')}
      </button>
    </div>
  );
}

/* ── Project Settings Panel ── */

type ProjectConnectionPreview = {
  profiles: Array<{
    id: string;
    display_name: string;
    provider: string;
    active: boolean;
    public_env_names: string[];
    secret_env_names: string[];
    referenced_credentials: Array<{
      env_name: string;
      credential_id: string;
      display_name: string;
      available: boolean;
    }>;
  }>;
  loose_allowed_credentials: Array<{
    id: string;
    display_name: string;
    provider: string;
    env_name: string | null;
    active: boolean;
  }>;
  targets: Array<{
    id: number;
    credential_id: string;
    target_type: string;
    target_ref: { repo?: string; secret_name?: string };
    last_status: string | null;
    last_checked_at: string | null;
    last_synced_at: string | null;
    last_error: string | null;
  }>;
  warnings: Array<{ type: string; credential_id: string; env_name: string | null; message: string }>;
};

function ProjectConnectionsPreview({ projectId }: { projectId: string }) {
  const { t } = useTranslation('layout');
  const [preview, setPreview] = useState<ProjectConnectionPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    setLoading(true);
    fetch(`/api/credential-vault/projects/${projectId}/preview`, { headers })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to load connections');
        return res.json();
      })
      .then((data) => { if (!cancelled) { setPreview(data); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err.message || 'Failed to load connections'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  const targetsByCredential = useMemo(() => {
    const map = new Map<string, ProjectConnectionPreview['targets']>();
    for (const target of preview?.targets ?? []) {
      const list = map.get(target.credential_id) ?? [];
      list.push(target);
      map.set(target.credential_id, list);
    }
    return map;
  }, [preview?.targets]);

  const pill = (text: string, tone: 'ok' | 'warn' | 'muted' = 'muted') => (
    <span className={`tone-pill px-1.5 py-0.5 rounded-full text-[11px] font-medium ${tone === 'ok' ? 'tone-success' : tone === 'warn' ? 'tone-warning' : 'tone-muted'}`}>
      {text}
    </span>
  );

  if (loading) return <div className="text-[13px] text-surface-500">{t('loadingConnections')}</div>;
  if (error) return <div className="tone-card tone-warning text-[13px] rounded p-2">{error}</div>;

  const hasConnections = (preview?.profiles?.length ?? 0) > 0 || (preview?.loose_allowed_credentials?.length ?? 0) > 0;

  return (
    <div className="space-y-2">
      {!hasConnections && <div className="text-[13px] text-surface-500">{t('noProjectConnections')}</div>}

      {preview?.profiles.map((profile) => (
        <div key={profile.id} className="rounded-md border border-surface-700 bg-surface-850/70 p-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[14px] text-gray-200 font-medium truncate">{profile.display_name}</div>
              <div className="text-[12px] text-surface-500 truncate">{profile.provider} · {profile.id}</div>
            </div>
            {pill(profile.active ? 'Connected' : 'Needs attention', profile.active ? 'ok' : 'warn')}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {profile.public_env_names.map((name) => pill(name))}
            {profile.secret_env_names.map((name) => pill(`${name} • secret`, profile.active ? 'ok' : 'warn'))}
          </div>
          {profile.referenced_credentials.length > 0 && (
            <div className="mt-2 space-y-1">
              {profile.referenced_credentials.map((credential) => (
                <div key={`${profile.id}:${credential.env_name}`} className="flex items-center justify-between gap-2 text-[12px]">
                  <span className="text-surface-400 truncate">{credential.display_name} → {credential.env_name}</span>
                  {pill(credential.available ? 'allowed' : 'not allowed', credential.available ? 'ok' : 'warn')}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {preview?.loose_allowed_credentials.map((credential) => (
        <div key={credential.id} className="tone-card tone-warning rounded-md p-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[14px] text-gray-200 font-medium truncate">{credential.display_name}</div>
              <div className="text-[12px] text-surface-500 truncate">{credential.provider} · {credential.env_name || 'no env'}</div>
            </div>
            {pill('Direct key', 'warn')}
          </div>
          {(targetsByCredential.get(credential.id) ?? []).map((target) => (
            <div key={target.id} className="mt-1 text-[12px] text-surface-500 truncate">
              {t('githubActions')}: {target.target_ref.repo || 'repo'} / {target.target_ref.secret_name || 'secret'}
              {target.last_status ? ` · ${target.last_status}` : ''}
            </div>
          ))}
        </div>
      ))}

      {preview?.warnings?.length ? (
        <div className="tone-card tone-warning text-[12px] rounded p-2">
          {t('connectionWarnings', { count: preview.warnings.length })}
        </div>
      ) : null}
    </div>
  );
}

function ProjectSettingsPanel({ project, onClose }: { project: Project; onClose: () => void }) {
  const { t } = useTranslation('layout');
  const [description, setDescription] = useState(project.description || '');
  const [rootPath, setRootPath] = useState(project.rootPath || '');
  const [saving, setSaving] = useState(false);
  const [members, setMembers] = useState<{ userId: number; username: string; role: string }[]>([]);
  const [memberSearch, setMemberSearch] = useState('');
  const [searchResults, setSearchResults] = useState<{ id: number; username: string }[]>([]);
  const [isOwner, setIsOwner] = useState(false);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const getAuthHeaders = () => {
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
  };

  const currentUserId = getCurrentUserId() || null;

  const isAdmin = getCurrentRole() === 'admin';

  useEffect(() => {
    fetchMembers();
  }, []);

  const fetchMembers = async () => {
    try {
      const res = await fetch(`/api/projects/${project.id}/members`, { headers: getAuthHeaders() });
      if (res.ok) {
        const data = await res.json();
        setMembers(data);
        setIsOwner(isAdmin || data.some((m: any) => m.userId === currentUserId && m.role === 'owner'));
      }
    } catch {}
  };

  const searchUsers = (q: string) => {
    setMemberSearch(q);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    if (!q.trim()) { setSearchResults([]); return; }
    searchTimeoutRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`, { headers: getAuthHeaders() });
        if (res.ok) {
          const users = await res.json();
          setSearchResults(users.filter((u: any) => !members.some(m => m.userId === u.id)));
        }
      } catch {}
    }, 300);
  };

  const handleAddMember = async (userId: number) => {
    try {
      await fetch(`/api/projects/${project.id}/members`, {
        method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ userId }),
      });
      setMemberSearch(''); setSearchResults([]);
      fetchMembers();
    } catch {}
  };

  const handleRemoveMember = async (userId: number) => {
    try {
      const res = await fetch(`/api/projects/${project.id}/members/${userId}`, {
        method: 'DELETE', headers: getAuthHeaders(),
      });
      if (!res.ok) {
        const data = await res.json();
        emitProductNotice({ code: 'sidebar.member.remove.failed', technicalDetail: data.error, context: { status: res.status } });
      }
      fetchMembers();
    } catch {}
  };

  const handleSave = async () => {
    setSaving(true);
    const headers = getAuthHeaders();
    try {
      const body: Record<string, any> = {};
      if (description !== (project.description || '')) body.description = description || null;
      if (rootPath !== (project.rootPath || '')) body.rootPath = rootPath || null;
      if (Object.keys(body).length > 0) {
        const res = await fetch(`/api/projects/${project.id}`, {
          method: 'PATCH', headers, body: JSON.stringify(body),
        });
        if (res.ok) {
          const updated = await res.json();
          useProjectStore.getState().updateProject(project.id, updated);
          toastSuccess('Project updated');
        } else {
          toastError('Failed to update project');
        }
      }
    } catch {
      toastError('Failed to update project');
    }
    setSaving(false);
    onClose();
  };

  const labelClass = "text-[12px] text-surface-500 uppercase tracking-wider font-medium mb-1";
  const inputClass = "w-full bg-surface-700 border border-surface-600 rounded text-[14px] text-gray-200 px-2.5 py-1.5 placeholder-surface-600 outline-none focus:border-primary-500/50";

  return (
    <div className="bg-surface-800 border border-surface-700 rounded-lg shadow-xl p-3 min-w-[280px] max-w-[320px]">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[15px] font-semibold text-gray-200">{project.name}</h3>
        <button onClick={onClose} className="text-surface-600 hover:text-gray-300 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Members */}
      <div className="mb-3">
        <div className={labelClass}>{t('projectMembers')}</div>
        <div className="space-y-1 mb-2">
          {members.map(m => (
            <div key={m.userId} className="flex items-center justify-between text-[13px]">
              <span className="text-gray-300">
                {m.role === 'owner' ? '👑 ' : '👤 '}{m.username}
                {m.userId === currentUserId && <span className="text-surface-600 ml-1">{t('youParenthetical')}</span>}
              </span>
              {isOwner && m.userId !== currentUserId && (
                <button onClick={() => handleRemoveMember(m.userId)} className="text-surface-600 hover:text-red-400 transition-colors">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              )}
            </div>
          ))}
          {members.length === 0 && <span className="text-[13px] text-surface-600">{t('noMembers')}</span>}
        </div>

        {/* Add member search */}
        {isOwner && (
          <div className="relative">
            <input
              value={memberSearch}
              onChange={(e) => searchUsers(e.target.value)}
              placeholder={t('addMemberPlaceholder')}
              className="w-full bg-surface-700 border border-surface-600 rounded text-[13px] text-gray-300 px-2 py-1 placeholder-surface-600 outline-none focus:border-primary-500/50"
            />
            {searchResults.length > 0 && (
              <div className="absolute left-0 right-0 top-full mt-0.5 bg-surface-900 border border-surface-700 rounded shadow-lg z-10 max-h-[100px] overflow-y-auto">
                {searchResults.map(u => (
                  <button
                    key={u.id}
                    onClick={() => handleAddMember(u.id)}
                    className="w-full text-left px-2 py-1 text-[13px] text-gray-300 hover:bg-surface-700 transition-colors"
                  >
                    {u.username}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Description */}
      <div className="mb-3">
        <div className={labelClass}>{t('projectDescription')}</div>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('projectDescPlaceholder')}
          rows={2}
          className={`${inputClass} resize-none`}
        />
        <p className="text-[11px] text-surface-600 mt-0.5">{t('alsoSavedToAgentsMd')}</p>
      </div>

      {/* Root Path */}
      <div className="mb-3">
        <div className={labelClass}>{t('projectFolder')}</div>
        <input
          value={rootPath}
          onChange={(e) => setRootPath(e.target.value)}
          placeholder={t('autoCreatedIn')}
          className={inputClass}
        />
        <p className="text-[11px] text-surface-600 mt-0.5">{t('newChatsUseProjectFolder')}</p>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="px-3 py-1 text-[13px] text-surface-500 hover:text-gray-300 transition-colors">
          {t('common:cancel')}
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-3 py-1.5 bg-primary-600 hover:bg-primary-500 rounded text-[13px] font-medium text-white transition-colors disabled:opacity-50"
        >
          {saving ? t('common:saving') : t('common:save')}
        </button>
      </div>
    </div>
  );
}

/* ── New Project Button ── */

function NewProjectButton() {
  const { t } = useTranslation('layout');
  const [creating, setCreating] = useState(false);
  // useRef guard — synchronous, closes the race where two rapid Enter
  // presses both observe submitting=false from a stale closure before
  // React re-renders. See workspace/decisions/2026-04-20-project-create-dedup.md
  const submittingRef = useRef(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');

  const [searchResults, setSearchResults] = useState<{ id: number; username: string }[]>([]);
  const [selectedMembers, setSelectedMembers] = useState<{ id: number; username: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (creating) {
      inputRef.current?.focus();
    }
  }, [creating]);

  useEffect(() => {
    if (!creating) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        resetForm();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [creating]);

  const resetForm = () => {
    setName(''); setSlug(''); setSlugTouched(false); setMemberSearch(''); setSearchResults([]); setSelectedMembers([]);
    setCreating(false);
  };

  const handleNameChange = (value: string) => {
    setName(value);
    if (!slugTouched) setSlug(deriveProjectSlugFromName(value));
  };

  const handleSlugChange = (value: string) => {
    setSlugTouched(true);
    setSlug(normalizeProjectSlugInput(value));
  };

  const searchUsers = (q: string) => {
    setMemberSearch(q);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    if (!q.trim()) { setSearchResults([]); return; }
    searchTimeoutRef.current = setTimeout(async () => {
      const token = localStorage.getItem('token');
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      try {
        const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`, { headers });
        if (res.ok) {
          const users = await res.json();
          setSearchResults(users.filter((u: any) => !selectedMembers.some(m => m.id === u.id)));
        }
      } catch {}
    }, 300);
  };

  const addMember = (user: { id: number; username: string }) => {
    setSelectedMembers(prev => [...prev, user]);
    setMemberSearch(''); setSearchResults([]);
  };

  const removeMember = (userId: number) => {
    setSelectedMembers(prev => prev.filter(m => m.id !== userId));
  };

  const handleCreate = async () => {
    if (submittingRef.current) return;
    const trimmed = name.trim();
    const trimmedSlug = slug.trim();
    if (!trimmed) { setCreating(false); return; }
    if (!isValidProjectSlug(trimmedSlug)) {
      toastError(t('projectSlugRequired'));
      return;
    }
    submittingRef.current = true;
    try {
      const token = localStorage.getItem('token');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const body: any = { name: trimmed, slug: trimmedSlug };
      if (selectedMembers.length > 0) body.memberIds = selectedMembers.map(m => m.id);
      const res = await fetch('/api/projects', {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      if (res.ok) {
        const project = await res.json();
        useProjectStore.getState().addProject(project);
        toastSuccess(`Project "${trimmed}" created`);
      } else {
        toastError('Failed to create project');
      }
    } catch {
      toastError('Failed to create project');
    } finally {
      submittingRef.current = false;
      resetForm();
    }
  };

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        onClick={() => setCreating(!creating)}
        className="p-1.5 rounded-md text-surface-600 hover:text-primary-400 hover:bg-surface-800 transition-colors shrink-0"
        title={t('newProject')}
        aria-label={t('newProject')}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
        </svg>
      </button>
      {creating && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-surface-800 border border-surface-700 rounded-lg shadow-xl p-2 min-w-[280px] space-y-2">
          <div>
            <label className="block text-[11px] text-surface-500 uppercase tracking-wider font-medium mb-1">
              {t('projectDisplayName')}
            </label>
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !memberSearch) handleCreate();
                if (e.key === 'Escape') resetForm();
              }}
              placeholder={t('projectNamePlaceholder')}
              className="w-full bg-surface-700 border border-surface-600 rounded text-[14px] text-gray-200 px-2.5 py-1.5 placeholder-surface-600 outline-none focus:border-primary-500/50"
            />
          </div>
          <div>
            <label className="block text-[11px] text-surface-500 uppercase tracking-wider font-medium mb-1">
              {t('projectEnglishId')}
            </label>
            <input
              value={slug}
              onChange={(e) => handleSlugChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !memberSearch) handleCreate();
                if (e.key === 'Escape') resetForm();
              }}
              placeholder={t('projectSlugPlaceholder')}
              className="w-full bg-surface-700 border border-surface-600 rounded text-[13px] text-gray-200 font-mono px-2.5 py-1.5 placeholder-surface-600 outline-none focus:border-primary-500/50"
            />
            <p className="mt-1 text-[11px] text-surface-500">{t('projectSlugHint')}</p>
          </div>

          {/* Member invite */}
          <div className="relative">
            <input
              value={memberSearch}
              onChange={(e) => searchUsers(e.target.value)}
              placeholder={t('inviteMembersHint')}
              className="w-full bg-surface-700 border border-surface-600 rounded text-[13px] text-gray-300 px-2 py-1.5 placeholder-surface-600 outline-none focus:border-primary-500/50"
            />
            {searchResults.length > 0 && (
              <div className="absolute left-0 right-0 top-full mt-0.5 bg-surface-900 border border-surface-700 rounded shadow-lg z-10 max-h-[120px] overflow-y-auto">
                {searchResults.map(u => (
                  <button
                    key={u.id}
                    onClick={() => addMember(u)}
                    className="w-full text-left px-2 py-1 text-[13px] text-gray-300 hover:bg-surface-700 transition-colors"
                  >
                    {u.username}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Selected members */}
          {selectedMembers.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {selectedMembers.map(m => (
                <span key={m.id} className="inline-flex items-center gap-0.5 text-[12px] bg-primary-600/20 text-primary-300 border border-primary-500/30 px-1.5 py-0.5 rounded-full">
                  {m.username}
                  <button onClick={() => removeMember(m.id)} className="text-primary-400 hover:text-red-400 ml-0.5">
                    <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </span>
              ))}
            </div>
          )}

          <p className="text-[12px] text-surface-600 px-0.5">
            {selectedMembers.length > 0
              ? t('invitedMembersCanSee')
              : t('onlyYouAndAdmin')
            }
          </p>
        </div>
      )}
    </div>
  );
}

/* ── Create Deck (inline input inside ProjectContextMenu) ── */

function CreateDeckInline({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t } = useTranslation('layout');
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  const handleCreate = async () => {
    const label = name.trim();
    if (!label) return;
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
      // Create a placeholder session tagged with this deck label. Do not use the
      // deck label as the session title: a deck is a grouping label, not the
      // conversation name shown in the sidebar.
      const res = await fetch('/api/sessions', {
        method: 'POST', headers,
        body: JSON.stringify({ projectId, label }),
      });
      if (!res.ok) { toastError('Failed to create deck'); onClose(); return; }
      const session = await res.json();
      useSessionStore.getState().addSession(session);
      toastSuccess(`Deck "${label}" created`);
    } catch {
      toastError('Failed to create deck');
    }
    onClose();
  };

  const itemClass = "w-full flex items-center gap-2 px-3 py-1.5 text-[14px] text-gray-300 hover:bg-primary-600/30 hover:text-white transition-colors";

  if (!open) {
    return (
      <button className={itemClass} onClick={() => setOpen(true)}>
        <svg className="w-3.5 h-3.5 text-primary-500/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
        </svg>
        {t('createDeck')}
      </button>
    );
  }

  return (
    <div className="px-2 py-1.5 flex items-center gap-1.5">
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleCreate();
          if (e.key === 'Escape') setOpen(false);
        }}
        onClick={(e) => e.stopPropagation()}
        placeholder={t('deckNamePlaceholder')}
        className="flex-1 bg-surface-700 text-[13px] text-gray-200 px-2 py-1 rounded border border-surface-600 outline-none focus:border-primary-500/50 placeholder-surface-600"
      />
      {name.trim() && (
        <button onClick={handleCreate} className="text-[12px] text-primary-400 hover:text-primary-300 font-medium px-1 shrink-0">
          Create
        </button>
      )}
    </div>
  );
}

/* ── Manage Decks Panel (inside ProjectContextMenu) ── */

function ManageDecksPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t } = useTranslation('layout');
  const confirm = useConfirm();
  const sessions = useSessionStore((s) => s.sessions);
  const [newDeckName, setNewDeckName] = useState('');
  const [addingDeck, setAddingDeck] = useState(false);
  const newDeckRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (addingDeck) setTimeout(() => newDeckRef.current?.focus(), 50);
  }, [addingDeck]);

  // Collect all labels for this project. Visibility states are now just
  // expanded/collapsed (handled by the sidebar itself) and archived (the
  // delete action below). The legacy "hidden" middle state was removed on
  // 2026-05-11 — see workspace/decisions/2026-05-11-remove-hide-keep-collapse-and-archive.md.
  const projectSessions = sessions.filter(s => s.projectId === projectId);
  const labelMap = new Map<string, number>();
  for (const s of projectSessions) {
    if (s.label) {
      labelMap.set(s.label, (labelMap.get(s.label) || 0) + 1);
    }
  }
  const allLabels = [...labelMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const handleCreateDeck = async () => {
    const label = newDeckName.trim();
    if (!label) return;
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST', headers,
        body: JSON.stringify({ projectId, label }),
      });
      if (!res.ok) { onClose(); return; }
      const session = await res.json();
      useSessionStore.getState().addSession(session);
      setNewDeckName('');
      setAddingDeck(false);
    } catch {}
  };

  const handleDeleteDeck = async (label: string) => {
    const deckSessions = projectSessions.filter(s => s.label === label);
    const msg = t('archiveWarning', { count: deckSessions.length });
    const ok = await confirm({
      title: t('archiveDeck', { defaultValue: 'Archive deck' }),
      message: msg,
      confirmLabel: t('common:archive', { defaultValue: 'Archive' }),
      danger: true,
    });
    if (!ok) return;
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const store = useSessionStore.getState();
    for (const s of deckSessions) {
      fetch(`/api/sessions/${s.id}`, { method: 'DELETE', headers }).catch(() => {});
      store.removeSession(s.id);
    }
  };

  return (
    <div className="bg-surface-800 border border-surface-700 rounded-lg shadow-xl min-w-[240px] max-w-[300px]">
      {/* Header */}
      <div className="px-3 py-2 border-b border-surface-700/50 flex items-center gap-2">
        <svg className="w-3.5 h-3.5 text-primary-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
        </svg>
        <span className="text-[14px] font-medium text-gray-200">{t('manageDecks')}</span>
      </div>

      {/* Decks — single flat list. Per-deck collapse is handled in the sidebar.
          The only destructive action here is archive (delete). */}
      <div className="max-h-[240px] overflow-y-auto py-1">
        {allLabels.length === 0 && (
          <div className="px-3 py-3 text-[13px] text-surface-500 text-center">{t('noDecksYet')}</div>
        )}
        {allLabels.map(([label, count]) => (
          <div key={label} className="flex items-center gap-1 px-2 py-1 group/deck hover:bg-surface-750 rounded mx-1">
            <svg className="w-3 h-3 text-primary-500/50 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
            </svg>
            <span className="flex-1 text-[14px] text-gray-300 truncate">{label}</span>
            <span className="text-[12px] text-surface-600 tabular-nums shrink-0">{count}</span>
            {/* Delete (archive) button */}
            <button
              onClick={() => handleDeleteDeck(label)}
              className="p-0.5 rounded text-surface-600 hover:text-red-400 transition-colors opacity-0 group-hover/deck:opacity-100"
              title={t('deleteDeck')}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        ))}
      </div>

      {/* Create new deck */}
      <div className="px-2 py-1.5 border-t border-surface-700/50">
        {addingDeck ? (
          <div className="flex items-center gap-1.5">
            <input
              ref={newDeckRef}
              value={newDeckName}
              onChange={(e) => setNewDeckName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateDeck();
                if (e.key === 'Escape') { setNewDeckName(''); setAddingDeck(false); }
              }}
              onClick={(e) => e.stopPropagation()}
              placeholder={t('deckNamePlaceholder')}
              className="flex-1 bg-surface-700 text-[13px] text-gray-200 px-2 py-1 rounded border border-surface-600 outline-none focus:border-primary-500/50 placeholder-surface-600"
            />
            {newDeckName.trim() && (
              <button onClick={handleCreateDeck} className="text-[12px] text-primary-400 hover:text-primary-300 font-medium px-1 shrink-0">
                {t('addDeck')}
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAddingDeck(true)}
            className="tone-action tone-accent flex w-full items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[13px] font-semibold"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            {t('addDeckButton')}
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Space Move Submenu (inside ProjectContextMenu) ── */

function SpaceMoveSubmenu({ projectId, currentSpaceId, onClose }: {
  projectId: string;
  currentSpaceId: number | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('layout');
  const spaces = useSpaceStore((s) => s.spaces);
  const [open, setOpen] = useState(false);

  if (spaces.length === 0) return null;

  const handleMove = async (spaceId: number | null) => {
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH', headers, body: JSON.stringify({ spaceId }),
      });
      if (res.ok) {
        const updated = await res.json();
        useProjectStore.getState().updateProject(projectId, updated);
        toastSuccess(`Moved to ${spaceId === null ? t('uncategorized') : spaces.find(s => s.id === spaceId)?.name || 'space'}`);
      }
    } catch {}
    onClose();
  };

  const itemClass = "w-full flex items-center gap-2 px-3 py-1.5 text-[14px] text-gray-300 hover:bg-primary-600/30 hover:text-white transition-colors";

  return (
    <div className="relative">
      <button className={itemClass} onClick={() => setOpen(!open)}>
        <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
        </svg>
        {t('moveSpace')}
        <svg className={`w-3 h-3 ml-auto text-surface-600 transition-transform ${open ? 'rotate-90' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>
      {open && (
        <div className="py-1 border-t border-surface-700/30">
          {spaces.map((space) => (
            <button
              key={space.id}
              onClick={() => handleMove(space.id)}
              className={`${itemClass} pl-6 ${currentSpaceId === space.id ? '!text-primary-400' : ''}`}
              disabled={currentSpaceId === space.id}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: space.color }} />
              {space.name}
              {currentSpaceId === space.id && (
                <svg className="w-3 h-3 ml-auto text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          ))}
          <div className="border-t border-surface-700/30 my-0.5" />
          <button
            onClick={() => handleMove(null)}
            className={`${itemClass} pl-6 ${currentSpaceId === null ? '!text-primary-400' : ''}`}
            disabled={currentSpaceId === null}
          >
            <span className="w-2 h-2 rounded-full shrink-0 bg-gray-600" />
            {t('uncategorized')}
            {currentSpaceId === null && (
              <svg className="w-3 h-3 ml-auto text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Label Group — Obsidian-style tree node (D&D drop target) ── */

const LABEL_PREVIEW_COUNT = 5;

/** Label display name mapping */
function labelDisplay(label: string, t?: (key: string, options?: any) => string): { name: string } {
  const map: Record<string, string> = {
    'channel_ai': 'Channel AI',
    'temp': t ? t('defaultDeck') : 'Default',
    'task': '⚡ Tasks',
  };
  return { name: map[label] || label };
}

/* ── Deck Context Menu ── */

function DeckContextMenu({ x, y, label, sessions, projectId, onClose }: {
  x: number; y: number; label: string; sessions: SessionMeta[]; projectId: string; onClose: () => void;
}) {
  const { t } = useTranslation('layout');
  const ref = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState({ left: x, top: y });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameName, setRenameName] = useState(label);
  const renameRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const pad = 8;
    const anchoredBottom = y + rect.height;
    const anchoredRight = x + rect.width;
    const newTop = anchoredBottom > window.innerHeight - pad
      ? Math.max(pad, window.innerHeight - rect.height - pad) : y;
    const newLeft = anchoredRight > window.innerWidth - pad
      ? Math.max(pad, window.innerWidth - rect.width - pad) : x;
    setAdjustedPos(prev => prev.left === newLeft && prev.top === newTop ? prev : { left: newLeft, top: newTop });
  }, [x, y]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  useEffect(() => {
    if (renaming) setTimeout(() => renameRef.current?.focus(), 50);
  }, [renaming]);

  const itemClass = "w-full flex items-center gap-2 px-3 py-1.5 text-[14px] text-gray-300 hover:bg-primary-600/30 hover:text-white transition-colors";

  const patchSessions = (patch: Record<string, any>) => {
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    for (const s of sessions) {
      useSessionStore.getState().updateSessionMeta(s.id, patch);
      fetch(`/api/sessions/${s.id}`, {
        method: 'PATCH', headers, body: JSON.stringify(patch),
      }).catch(() => {});
    }
  };

  const handleRename = () => {
    const newName = renameName.trim();
    if (!newName || newName === label) { setRenaming(false); return; }
    // Update all sessions with the new label
    patchSessions({ label: newName });
    // Note: any `collapsedLabels` entry under the old label key becomes a dead
    // key. It drops out naturally on next render since no deck has that label
    // anymore — no explicit migration needed. (Removed `hidden` concept on
    // 2026-05-11; see workspace/decisions/2026-05-11-remove-hide-keep-collapse-and-archive.md)
    onClose();
  };

  const allProject = sessions.every(s => s.visibility === 'project');
  const hasProjectId = sessions.some(s => s.projectId);

  if (renaming) {
    return (
      <div ref={ref} className="fixed z-50 bg-surface-800 border border-surface-700 rounded-lg shadow-xl py-1 min-w-[180px]"
        style={adjustedPos}>
        <div className="px-2 py-1.5 flex items-center gap-1.5">
          <input
            ref={renameRef}
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') setRenaming(false);
            }}
            onClick={(e) => e.stopPropagation()}
            placeholder={t('deckNewName')}
            className="flex-1 bg-surface-700 text-[13px] text-gray-200 px-2 py-1 rounded border border-surface-600 outline-none focus:border-primary-500/50 placeholder-surface-600"
          />
          {renameName.trim() && renameName.trim() !== label && (
            <button onClick={handleRename} className="text-[12px] text-primary-400 hover:text-primary-300 font-medium px-1 shrink-0">
              OK
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={ref} className="fixed z-50 bg-surface-800 border border-surface-700 rounded-lg shadow-xl py-1 min-w-[180px]"
      style={adjustedPos}>
      {/* Rename deck */}
      <button className={itemClass} onClick={() => setRenaming(true)}>
        <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round"
            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
        {t('renameDeck')}
      </button>
      <div className="border-t border-surface-700/50 my-1" />
      {/* Visibility toggle — only if sessions are in a project */}
      {hasProjectId && (
        <button className={itemClass} onClick={() => {
          const newVis = allProject ? 'private' : 'project';
          patchSessions({ visibility: newVis });
          onClose();
        }}>
          {allProject ? (
            <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          )}
          {allProject ? t('makeAllPrivate') : t('shareAllWithProject')}
        </button>
      )}
      {/* Ungroup all sessions in this deck */}
      <button className={itemClass} onClick={() => {
        const token = localStorage.getItem('token');
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        for (const s of sessions) {
          useSessionStore.getState().updateSessionMeta(s.id, { label: null });
          fetch(`/api/sessions/${s.id}`, {
            method: 'PATCH', headers, body: JSON.stringify({ label: null }),
          }).catch(() => {});
        }
        onClose();
      }}>
        <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6" />
        </svg>
        {t('ungroupAll')} ({sessions.length})
      </button>
      <div className="border-t border-surface-700/50 my-1" />
      {/* Delete deck — with confirmation */}
      {!confirmDelete ? (
        <button className={`${itemClass} !text-red-400 hover:!bg-red-950/30`} onClick={() => setConfirmDelete(true)}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
          </svg>
          {t('deleteDeck')} ({sessions.length})
        </button>
      ) : (
        <div className="px-2 py-1.5">
          <p className="text-[13px] text-red-400 mb-2 px-1">
            {t('archiveWarning', { count: sessions.length })}
          </p>
          <div className="flex gap-1.5">
            <button
              className="flex-1 px-2 py-1 text-[13px] bg-red-600/20 text-red-400 rounded hover:bg-red-600/30 transition-colors border border-red-600/30"
              onClick={() => {
                const token = localStorage.getItem('token');
                const headers: Record<string, string> = {};
                if (token) headers['Authorization'] = `Bearer ${token}`;
                for (const s of sessions) {
                  fetch(`/api/sessions/${s.id}`, { method: 'DELETE', headers }).catch(() => {});
                }
                // Remove from UI
                const store = useSessionStore.getState();
                for (const s of sessions) {
                  store.removeSession(s.id);
                }
                onClose();
              }}
            >
              {t('deleteAll')}
            </button>
            <button
              className="flex-1 px-2 py-1 text-[13px] bg-surface-700 text-gray-400 rounded hover:bg-surface-600 transition-colors"
              onClick={() => setConfirmDelete(false)}
            >
              {t('common:cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function LabelGroup({ label, sessions, projectId, isCollapsed, onToggle, onDropSession, activeSessionId, currentUsername, onSelectSession, onDeleteSession, onRenameSession, onToggleFavorite, onMoveSession, projects, onNewSession, isSystemGroup = false }: {
  label: string;
  sessions: SessionMeta[];
  projectId: string;
  isCollapsed: boolean;
  onToggle: () => void;
  onDropSession: (sessionId: string) => void;
  activeSessionId: string | null;
  currentUsername?: string;
  onSelectSession: (s: SessionMeta) => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
  onToggleFavorite: (id: string, fav: boolean) => void;
  onMoveSession: (sessionId: string, projectId: string | null) => void;
  projects: Project[];
  // Create a new session pre-tagged into this deck. Shown as a hover "+" button
  // on the deck header; auto-places the session inside this deck group.
  onNewSession?: () => void;
  // Synthetic groups (currently Uncategorized) are navigation, not editable decks.
  isSystemGroup?: boolean;
}) {
  const { t } = useTranslation('layout');
  const [dragOver, setDragOver] = useState(false);
  const showAllKey = `label::${projectId}::${label}`;
  const [showAll, setShowAll] = useState(() => isSessionShowAllExpanded(showAllKey));
  const [visibleLimit, setVisibleLimit] = useState(() => getInitialSessionVisibleLimit(showAllKey));
  const toggleShowAll = useCallback(() => {
    setShowAll((prev) => {
      if (prev) {
        clearSessionStoredVisibleCount(showAllKey);
        setVisibleLimit(SESSION_INITIAL_EXPANDED_LIMIT);
        return false;
      }
      const nextLimit = getNextSessionVisibleLimit(sessions.length, LABEL_PREVIEW_COUNT, false, visibleLimit);
      setSessionStoredVisibleCount(showAllKey, nextLimit);
      setVisibleLimit(nextLimit);
      return true;
    });
  }, [sessions.length, showAllKey, visibleLimit]);
  const showMoreSessions = useCallback(() => {
    setShowAll(true);
    setVisibleLimit((prev) => {
      const next = getNextSessionVisibleLimit(sessions.length, LABEL_PREVIEW_COUNT, showAll, prev);
      setSessionStoredVisibleCount(showAllKey, next);
      return next;
    });
  }, [sessions.length, showAll, showAllKey]);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const hasMore = sessions.length > LABEL_PREVIEW_COUNT;
  const displayedCount = getSessionDisplayCount(sessions.length, LABEL_PREVIEW_COUNT, showAll, visibleLimit);
  const remainingCount = sessions.length - displayedCount;
  const nextBatchCount = getNextSessionBatchCount(sessions.length, LABEL_PREVIEW_COUNT, showAll, visibleLimit);
  const visibleSessions = !isCollapsed ? sessions.slice(0, displayedCount) : [];
  const display = labelDisplay(label, t);

  return (
    <div className="group/label">
      {/* Label header — clean section style */}
      <div
        onClick={onToggle}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!isSystemGroup) setCtxMenu({ x: e.clientX, y: e.clientY });
        }}
        // dragenter + contains-check로 자식(SVG/span) 진입 시의 flicker 방지
        onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const sessionId = e.dataTransfer.getData('text/plain');
          if (sessionId) onDropSession(sessionId);
        }}
        className={`flex items-center gap-1.5 py-1 px-0.5 -ml-0.5 rounded-md cursor-pointer transition-colors select-none ${
          dragOver ? 'bg-primary-600/15' : 'hover:bg-surface-850'
        }`}
      >
        {/* Chevron */}
        <svg className={`w-3 h-3 text-surface-600 max-[768px]:text-gray-500 transition-transform shrink-0 ${isCollapsed ? '-rotate-90' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
        {/* Label name */}
        <span className="text-[15px] font-semibold text-surface-400 max-[768px]:text-gray-300 truncate">{display.name}</span>
        {/* Count */}
        {hasMore ? (
          <span
            onClick={(e) => {
              e.stopPropagation();
              remainingCount > 0 ? showMoreSessions() : toggleShowAll();
            }}
            data-sidebar-session-showall-label={remainingCount > 0 ? `${projectId}::${label}` : undefined}
            className="text-[12px] tabular-nums shrink-0 cursor-pointer transition-colors text-surface-600 hover:text-primary-400 max-[768px]:text-gray-500 ml-auto"
            title={remainingCount > 0 ? t('showNextSessions', { count: nextBatchCount }) : t('showOnlySessions', { count: LABEL_PREVIEW_COUNT })}
          >
            {remainingCount > 0 ? `${displayedCount}/${sessions.length}` : sessions.length}
          </span>
        ) : (
          <span className="text-[12px] tabular-nums text-surface-600 max-[768px]:text-gray-500 shrink-0 ml-auto">{sessions.length}</span>
        )}
        {/* + New session in this deck — visible on hover (desktop), always on mobile */}
        {onNewSession && (
          <button
            onClick={(e) => { e.stopPropagation(); onNewSession(); }}
            className="p-0.5 rounded text-surface-600 hover:text-primary-400 hover:bg-surface-700/50 max-[768px]:text-primary-500 max-[768px]:hover:text-primary-600 transition-all shrink-0 max-[768px]:opacity-100 opacity-0 group-hover/label:opacity-100"
            aria-label={t('newSessionInNamedDeck', { name: display.name })}
            title={t('newSessionInNamedDeck', { name: display.name })}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </button>
        )}
      </div>
      {/* Sessions — indented under label like tree children */}
      {!isCollapsed && (
        <div className="ml-2 pl-2.5 border-l border-surface-700/25 space-y-0.5">
          {visibleSessions.map((session) => (
            <SessionItem key={session.id} session={session} isActive={session.id === activeSessionId} currentUsername={currentUsername} onSelect={onSelectSession} onDelete={onDeleteSession} onRename={onRenameSession} onToggleFavorite={onToggleFavorite} onMoveToProject={onMoveSession} projects={projects} />
          ))}
        </div>
      )}
      {/* Deck context menu */}
      {!isSystemGroup && ctxMenu && (
        <DeckContextMenu x={ctxMenu.x} y={ctxMenu.y} label={label} sessions={sessions} projectId={projectId} onClose={() => setCtxMenu(null)} />
      )}
    </div>
  );
}
