import { create } from 'zustand';
import type { FileEntry as FileEntryBase } from '@tower/shared';
import { useSessionStore } from './session-store';
import { clearSessionViewportSnapshot } from '../features/conversation-viewport/sessionViewportSnapshot';

export interface FileEntry extends FileEntryBase {
  children?: FileEntry[];
  isExpanded?: boolean;
  isLoading?: boolean;
}

export type FileProjectSortMode = 'pinned-recent' | 'recent' | 'name' | 'created';
export type FileEntrySortMode = 'folders-name' | 'modified' | 'name' | 'type';

export interface OpenFile {
  path: string;
  content: string;
  language: string;
  modified: boolean;
  encoding?: string;
}

export type SplitOrientation = 'right' | 'bottom';
export type ActiveFilePane = 'main' | 'extra';

export interface FileTab {
  id: string;              // crypto.randomUUID()
  path: string;
  name?: string;
  content: string;
  language: string;
  modified: boolean;
  encoding?: string;
  scrollPos?: number;      // 탭별 스크롤 위치 기억
  pinned: boolean;         // true = 고정 탭, false = 임시 탭 (싱글 클릭)
  /** Which file pane owns the tab. Missing means legacy/main. Only one tab may be pane='extra'. */
  pane?: ActiveFilePane;
  lastAccessed?: number;
}

/**
 * A chat tab — a *bookmark* to a session, rendered in the main tab bar.
 *
 * v3 (path B, 2026-05-24): chat sessions are first-class multi-tabs, but
 * unlike files we do NOT mount a ChatPanel per tab. The single ChatPanel
 * follows `session-store.activeSessionId`. A chat tab is therefore just a
 * pointer: clicking it switches the active session (via handleSelectSession)
 * and enters chat mode (`activeTabId === null`). The "active chat tab" is the
 * one whose `sessionId === activeSessionId` while in chat mode.
 * See: workspace/decisions/2026-05-22-global-multi-tab-shell.md (v3)
 */
export interface ChatTab {
  id: string;          // crypto.randomUUID()
  sessionId: string;
  pinned: boolean;     // true = 고정 (replace 대상에서 제외, LRU 제외)
  /** ChatPanel viewport snapshot. Restores per-session scroll when switching chat tabs. */
  scrollTop?: number;
  /** Topmost visible message index. Used for virtualized (>80 message) sessions. */
  topVisibleIndex?: number;
  /** Whether the tab was last seen at the latest message. If true, restore to bottom. */
  atBottom?: boolean;
}

export type SystemTabKind = 'publishing' | 'projectFiles' | 'schedule';

export interface SystemTab {
  id: string;
  kind: SystemTabKind;
  /** Optional entity id for system tabs that can have multiple instances, e.g. schedule:<automationId>. */
  refId?: string;
  title: string;
  icon: string;
  pinned: boolean;
}

export interface TabOrderItem {
  kind: 'chat' | 'file' | 'system';
  id: string;
}

export interface ExternalChange {
  path: string;
  detectedAt: number;
}

// ─── Expanded paths persistence (per-user, per-tab) ───
//
// Storage choice: sessionStorage, NOT localStorage.
//
// Why: this set tracks which folders the user has clicked-to-expand. It has to
// survive within-tab events (sidebar tab switches, uploads, refreshTrigger
// bumps from file_changed events) and page reloads during a work session.
// But persisting across days of usage causes silent accumulation — every
// folder ever expanded stays in the set, and the recursive `fillExpanded`
// in ProjectFileSection would re-open them all on next visit, producing the
// "내가 안 연 것들이 열려 있다" feeling. sessionStorage gives us "current work
// session" scope: survives reloads, resets when the tab closes.
//
// We also do a one-time migration from the old localStorage key (silently
// discarding the accumulated state) so existing users get a fresh slate.
function getUserKey(): string {
  try {
    const token = localStorage.getItem('token');
    if (token) {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.username) return `fileTree:expandedPaths:${payload.username}`;
    }
  } catch {}
  return 'fileTree:expandedPaths';
}

// One-time migration: drop accumulated localStorage state from the era when
// this set was persistent across sessions. Runs once per tab-load; idempotent.
let migratedAwayFromLocalStorage = false;
function migrateLocalStorageOnce(): void {
  if (migratedAwayFromLocalStorage) return;
  migratedAwayFromLocalStorage = true;
  try {
    // Remove the per-user key
    localStorage.removeItem(getUserKey());
    // Also remove the un-namespaced fallback key in case it lingered
    localStorage.removeItem('fileTree:expandedPaths');
  } catch {}
}

function loadExpandedPaths(): Set<string> {
  migrateLocalStorageOnce();
  try {
    const raw = sessionStorage.getItem(getUserKey());
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set();
}

function saveExpandedPaths(paths: Set<string>): void {
  try {
    sessionStorage.setItem(getUserKey(), JSON.stringify([...paths]));
  } catch {}
}

/** Apply persisted expanded state recursively to a tree */
function applyExpandedState(entries: FileEntry[], expandedPaths: Set<string>): FileEntry[] {
  return entries.map((e) => {
    if (!e.isDirectory) return e;
    const isExpanded = expandedPaths.has(e.path) || !!e.isExpanded;
    const children = e.children ? applyExpandedState(e.children, expandedPaths) : e.children;
    return { ...e, isExpanded, children };
  });
}

/** Collect all expanded directory paths from the tree recursively */
function collectExpandedPaths(entries: FileEntry[], result: Set<string>): void {
  for (const e of entries) {
    if (e.isDirectory && e.isExpanded) {
      result.add(e.path);
    }
    if (e.children) {
      collectExpandedPaths(e.children, result);
    }
  }
}

// ─── Expanded projects persistence (per-user) ───
function getProjectsKey(): string {
  try {
    const token = localStorage.getItem('token');
    if (token) {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.username) return `fileTree:expandedProjects:${payload.username}`;
    }
  } catch {}
  return 'fileTree:expandedProjects';
}

function loadExpandedProjects(): Set<string> {
  try {
    const key = getProjectsKey();
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      return new Set(parsed);
    }
  } catch (e) {
    console.warn('[file-store] failed to load expanded projects:', e);
  }
  return new Set();
}

function saveExpandedProjects(projects: Set<string>): void {
  try {
    localStorage.setItem(getProjectsKey(), JSON.stringify([...projects]));
  } catch {}
}

// ─── Sidebar scroll position per tab (per-user, in-memory only — resets on reload, intentional) ───
// We don't persist to localStorage because tree contents may change between sessions

// ─── Show hidden files preference (per-user) ───
function getShowHiddenKey(): string {
  try {
    const token = localStorage.getItem('token');
    if (token) {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.username) return `fileTree:showHidden:${payload.username}`;
    }
  } catch {}
  return 'fileTree:showHidden';
}

function loadShowHidden(): boolean {
  try {
    return localStorage.getItem(getShowHiddenKey()) === 'true';
  } catch {}
  return false;
}

function saveShowHidden(show: boolean): void {
  try {
    localStorage.setItem(getShowHiddenKey(), String(show));
  } catch {}
}

function getFileSortKey(kind: 'project' | 'entry'): string {
  try {
    const token = localStorage.getItem('token');
    if (token) {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.username) return `fileTree:sort:${kind}:${payload.username}`;
    }
  } catch {}
  return `fileTree:sort:${kind}`;
}

function loadProjectSortMode(): FileProjectSortMode {
  try {
    const raw = localStorage.getItem(getFileSortKey('project')) as FileProjectSortMode | null;
    if (raw === 'pinned-recent' || raw === 'recent' || raw === 'name' || raw === 'created') return raw;
  } catch {}
  return 'pinned-recent';
}

function loadEntrySortMode(): FileEntrySortMode {
  try {
    const raw = localStorage.getItem(getFileSortKey('entry')) as FileEntrySortMode | null;
    if (raw === 'folders-name' || raw === 'modified' || raw === 'name' || raw === 'type') return raw;
  } catch {}
  return 'folders-name';
}

function saveProjectSortMode(mode: FileProjectSortMode): void {
  try { localStorage.setItem(getFileSortKey('project'), mode); } catch {}
}

function saveEntrySortMode(mode: FileEntrySortMode): void {
  try { localStorage.setItem(getFileSortKey('entry'), mode); } catch {}
}

// ─── Tabs persistence (per-user) ───
//
// 탭 상태(chatTabs + tabs + activeTabId) 를 localStorage 에 저장. 새로고침·재로그인
// 후에도 워킹 셋이 그대로. 다른 persistence 들(드래프트, 스크롤, 확장 폴더) 과
// 동일한 username 키 패턴.
//
// content 처리: 파일 탭의 .content 는 텍스트라 보통 작지만, 거대 파일(>500KB)
// 은 truncate 해서 빈 string 으로 저장 → 복원 후 활성화 시 자연스럽게 다시
// fetch 됨. localStorage 5MB 한계 보호.
//
// 결정: workspace/decisions/2026-05-22-global-multi-tab-shell.md (§ 새로고침 복원)
const TABS_PREFIX = 'tower:tabs:';
const PER_TAB_CONTENT_CAP = 500_000;  // 500KB — 그 이상은 lazy refetch

function getTabsKey(): string {
  try {
    const token = localStorage.getItem('token');
    if (token) {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.username) return TABS_PREFIX + payload.username;
    }
  } catch { /* fall through */ }
  return TABS_PREFIX + '__global';
}

interface PersistedTabs {
  chatTabs: ChatTab[];
  systemTabs: SystemTab[];
  tabs: FileTab[];
  activeTabId: string | null;
  activeSystemTabId: string | null;
  tabOrder: TabOrderItem[];
}

function tabPane(tab: FileTab | undefined, splitTabId?: string | null): ActiveFilePane {
  if (!tab) return 'main';
  if (tab.pane === 'extra' || (!!splitTabId && tab.id === splitTabId)) return 'extra';
  return 'main';
}

function mainFileTabs(tabs: FileTab[], splitTabId?: string | null): FileTab[] {
  return tabs.filter((tab) => tabPane(tab, splitTabId) === 'main');
}

function normalizeTabOrder(chatTabs: ChatTab[], tabs: FileTab[], systemTabs: SystemTab[], raw?: TabOrderItem[]): TabOrderItem[] {
  const valid = new Set<string>([
    ...chatTabs.map((t) => `chat:${t.id}`),
    ...tabs.map((t) => `file:${t.id}`),
    ...systemTabs.map((t) => `system:${t.id}`),
  ]);
  const seen = new Set<string>();
  const order: TabOrderItem[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const key = `${item.kind}:${item.id}`;
    if (!valid.has(key) || seen.has(key)) continue;
    seen.add(key);
    order.push(item);
  }
  for (const t of chatTabs) {
    const key = `chat:${t.id}`;
    if (!seen.has(key)) order.push({ kind: 'chat', id: t.id });
  }
  for (const t of tabs) {
    const key = `file:${t.id}`;
    if (!seen.has(key)) order.push({ kind: 'file', id: t.id });
  }
  for (const t of systemTabs) {
    const key = `system:${t.id}`;
    if (!seen.has(key)) order.push({ kind: 'system', id: t.id });
  }
  return order;
}

function loadPersistedTabs(): PersistedTabs {
  try {
    const raw = localStorage.getItem(getTabsKey());
    if (raw) {
      const data = JSON.parse(raw) as PersistedTabs;
      // 방어: 저장 형식이 구버전/손상 상태여도 앱 부팅을 막지 않도록 shape까지 정상화한다.
      const chatTabs = (Array.isArray(data.chatTabs) ? data.chatTabs : [])
        .filter((t): t is ChatTab => !!t && typeof t.id === 'string' && typeof t.sessionId === 'string')
        .map((t) => ({ ...t, pinned: !!t.pinned }));
      const systemTabs = (Array.isArray((data as Partial<PersistedTabs>).systemTabs) ? (data as Partial<PersistedTabs>).systemTabs! : [])
        .filter((t): t is SystemTab => !!t && typeof t.id === 'string' && (t.kind === 'publishing' || (t.kind === 'projectFiles' && typeof t.refId === 'string' && t.refId.length > 0) || t.kind === 'schedule'))
        .map((t) => ({ ...t, title: t.title || (t.kind === 'publishing' ? 'Publishing Hub' : t.kind === 'projectFiles' ? '프로젝트 홈' : '스케줄'), icon: t.icon || (t.kind === 'publishing' ? '🌐' : t.kind === 'projectFiles' ? '📁' : '⏰'), pinned: !!t.pinned }));
      const tabs: FileTab[] = (Array.isArray(data.tabs) ? data.tabs : [])
        .filter((t): t is FileTab => !!t && typeof t.id === 'string' && typeof t.path === 'string')
        .map((t): FileTab => ({
          ...t,
          name: typeof t.name === 'string' ? t.name : t.path.split('/').pop() || t.path,
          content: typeof t.content === 'string' ? t.content : '',
          language: typeof t.language === 'string' ? t.language : 'text',
          modified: !!t.modified,
          pinned: !!t.pinned,
          pane: t.pane === 'extra' ? 'extra' : 'main',
          lastAccessed: typeof t.lastAccessed === 'number' ? t.lastAccessed : Date.now(),
        }));
      const rawActiveTabId = typeof data.activeTabId === 'string' ? data.activeTabId : null;
      const activeTabId = rawActiveTabId && tabs.some((t) => t.id === rawActiveTabId) ? rawActiveTabId : null;
      const rawActiveSystemTabId = typeof (data as Partial<PersistedTabs>).activeSystemTabId === 'string'
        ? (data as Partial<PersistedTabs>).activeSystemTabId!
        : null;
      const activeSystemTabId = !activeTabId && rawActiveSystemTabId && systemTabs.some((t) => t.id === rawActiveSystemTabId)
        ? rawActiveSystemTabId
        : null;
      return {
        chatTabs,
        systemTabs,
        tabs,
        activeTabId,
        activeSystemTabId,
        tabOrder: normalizeTabOrder(chatTabs, tabs, systemTabs, (data as Partial<PersistedTabs>).tabOrder),
      };
    }
  } catch { /* corrupt → 기본값 */ }
  return { chatTabs: [], systemTabs: [], tabs: [], activeTabId: null, activeSystemTabId: null, tabOrder: [] };
}

function savePersistedTabs(state: PersistedTabs): void {
  try {
    const slim: PersistedTabs = {
      chatTabs: state.chatTabs,
      systemTabs: state.systemTabs,
      tabs: state.tabs.map((t) => ({
        ...t,
        content: t.content.length > PER_TAB_CONTENT_CAP ? '' : t.content,
      })),
      activeTabId: state.activeTabId,
      activeSystemTabId: state.activeSystemTabId,
      tabOrder: normalizeTabOrder(state.chatTabs, state.tabs, state.systemTabs, state.tabOrder),
    };
    localStorage.setItem(getTabsKey(), JSON.stringify(slim));
  } catch { /* quota full → silent */ }
}

interface FileState {
  tree: FileEntry[];
  treeRoot: string;
  expandedPaths: Set<string>;
  openFile: OpenFile | null;
  contextPanelOpen: boolean;
  contextPanelExpanded: boolean;
  contextPanelTab: 'preview' | 'write' | 'split' | 'source' | 'edit' | 'raw' | 'editor' | 'python';
  /**
   * Viewer Pane invariant: Tower has exactly one optional right-side viewer pane.
   * Opening another split/present file replaces this single splitTabId instead
   * of creating nested or multiple split panes.
   */
  splitTabId: string | null;
  splitOrientation: SplitOrientation;
  /** Which file pane receives file-tree/link opens. Chat sessions still use global activeSessionId. */
  activeFilePane: ActiveFilePane;
  lastOpenedFilePath: string | null;
  originalContent: string | null;
  externalChange: ExternalChange | null;
  /** Incremented on file_changed WS events — ProjectFileSection subscribes to auto-refresh */
  refreshTrigger: number;
  /** Set of project IDs whose file sections are expanded (persisted) */
  expandedProjects: Set<string>;
  /** Whether to show hidden/dotfiles in the file tree */
  showHidden: boolean;
  /** Project section sorting in the Files tab */
  projectSortMode: FileProjectSortMode;
  /** File/folder sorting inside each project tree */
  fileSortMode: FileEntrySortMode;
  /** Per-project file tree cache (survives ProjectFileSection unmount/remount) */
  projectTrees: Record<string, FileEntry[]>;
  /** Per-project initial-load flag (so we don't re-fetch root on every remount) */
  projectLoaded: Record<string, boolean>;
  /** Sidebar scroll position per tab — restored when the user returns to that tab */
  sidebarScroll: Record<string, number>;

  // ─── Tab state ───
  tabs: FileTab[];
  activeTabId: string | null;
  /** Chat tabs (session bookmarks). The active one = sessionId === activeSessionId while activeTabId===null. */
  chatTabs: ChatTab[];
  /** First-class app/system tabs such as Publishing Hub. */
  systemTabs: SystemTab[];
  activeSystemTabId: string | null;
  /** Unified visual order for chat/file/system tabs. */
  tabOrder: TabOrderItem[];

  // ─── Navigation history (back/forward within file viewer) ───
  navHistory: string[];   // list of file paths visited
  navIndex: number;       // current position in history (-1 = none)

  // ─── Multi-select state ───
  /** Set of selected file/folder paths */
  selectedPaths: Set<string>;
  /** Whether multi-select mode is active */
  selectMode: boolean;
  /** Last clicked path for Shift range selection */
  lastClickedPath: string | null;
  /** In-app file clipboard used by sidebar copy → paste flows */
  fileClipboard: { paths: string[]; copiedAt: number } | null;

  setTree: (entries: FileEntry[]) => void;
  setTreeRoot: (path: string) => void;
  setOpenFile: (file: OpenFile | null) => void;
  updateOpenFileContent: (content: string) => void;
  setContextPanelOpen: (open: boolean) => void;
  setContextPanelExpanded: (expanded: boolean) => void;
  setContextPanelTab: (tab: 'preview' | 'write' | 'split' | 'source' | 'edit' | 'raw' | 'editor' | 'python') => void;
  openSplitTab: (tabId: string, orientation: SplitOrientation) => void;
  moveTabToPane: (tabId: string, pane: ActiveFilePane, options?: { orientation?: SplitOrientation }) => void;
  closeSplitTab: () => void;
  returnSplitTabToMain: () => void;
  setActiveFilePane: (pane: ActiveFilePane) => void;
  toggleDirectory: (path: string) => void;
  setDirectoryChildren: (dirPath: string, children: FileEntry[]) => void;
  setDirectoryLoading: (dirPath: string, loading: boolean) => void;
  handleFileChange: (event: string, filePath: string) => void;
  markSaved: () => void;
  setExternalChange: (change: ExternalChange | null) => void;
  reloadFromDisk: (content: string) => void;
  keepLocalEdits: () => void;
  /** Trigger a refresh for ProjectFileSection components */
  bumpRefreshTrigger: () => void;
  /** Toggle a project's expanded/collapsed state in the file tab */
  toggleProjectExpanded: (projectId: string) => void;
  /** Check if a project section is expanded */
  isProjectExpanded: (projectId: string) => boolean;
  /** Toggle show hidden files */
  toggleShowHidden: () => void;
  setProjectSortMode: (mode: FileProjectSortMode) => void;
  setFileSortMode: (mode: FileEntrySortMode) => void;

  // ─── Per-project tree cache (replaces ProjectFileSection's local useState so
  //     tree state survives sidebar tab switches and component unmounts) ───
  setProjectTree: (projectId: string, entries: FileEntry[]) => void;
  updateProjectTree: (projectId: string, updater: (entries: FileEntry[]) => FileEntry[]) => void;
  markProjectLoaded: (projectId: string, loaded: boolean) => void;
  /** Add/remove a single path to the persisted expandedPaths set (for use by ProjectFileSection) */
  addExpandedPath: (path: string) => void;
  removeExpandedPath: (path: string) => void;
  /** Save sidebar scroll position for a given tab */
  setSidebarScroll: (tab: string, scrollTop: number) => void;

  // ─── Tab actions ───
  /**
   * Open or focus a file tab.
   * - If path is already open: focus that tab (regardless of forceNew).
   * - Else if forceNew=false (default): replace existing unpinned (temporary) tab.
   * - Else (forceNew=true, from shift/middle-click): push new tab without replacing.
   * Enforces TAB_CAP=6 via LRU on unpinned tabs. See:
   *   workspace/decisions/2026-05-22-global-multi-tab-shell.md
   */
  openTab: (path: string, content: string, language: string, encoding?: string, options?: { forceNew?: boolean; split?: SplitOrientation; name?: string; backgroundSplit?: boolean }) => void;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  closeAllTabs: () => void;
  setActiveTab: (id: string) => void;
  /** Enter chat mode (= activeTabId becomes null, file tabs stay). The active chat tab is the one matching activeSessionId. */
  activateChatSlot: () => void;
  openSystemTab: (kind: SystemTabKind, options?: { refId?: string; title?: string; icon?: string; forceNew?: boolean; pinned?: boolean }) => void;
  closeSystemTab: (id: string) => void;
  pinSystemTab: (id: string) => void;
  activateSystemTab: (id: string) => void;

  // ─── Chat tab actions (v3, path B) ───
  /**
   * Open or focus a chat tab for a session, and enter chat mode (activeTabId=null).
   * - If sessionId already has a tab → focus it (chat mode), no list change.
   * - forceNew=false (default, normal click) → replace the active unpinned chat
   *   tab (the one matching the current activeSessionId), else replace first
   *   unpinned, else append.
   * - forceNew=true (shift/middle-click) → always append a new chat tab.
   * Enforces CHAT_CAP=6 via LRU on unpinned tabs.
   * NOTE: does NOT set activeSessionId — the caller (handleSelectSession) owns
   * session activation + message loading.
   */
  openChatTab: (sessionId: string, options?: { forceNew?: boolean }) => void;
  /** Close a chat tab. Returns the next sessionId to activate (adjacent) if the
   *  closed tab was the active chat, else null. Caller activates it. */
  closeChatTab: (id: string) => string | null;
  /** Toggle pin on a chat tab. */
  pinChatTab: (id: string) => void;
  /** Save per-session ChatPanel viewport for chat-tab switching. */
  updateChatTabScroll: (sessionId: string, snapshot: { scrollTop?: number; topVisibleIndex?: number; atBottom?: boolean }) => void;
  reorderTabOrder: (activeKey: string, overKey: string) => void;
  updateTabContent: (id: string, content: string) => void;
  /** Update an opened file tab by path after an external disk reload. */
  updateTabContentByPath: (path: string, content: string) => void;
  /** Replace a tab path/name after an owner-scoped rename. */
  renameOpenTabPath: (oldPath: string, newPath: string, name?: string) => void;
  markTabSaved: (id: string) => void;
  markTabSavedByPath: (path: string) => void;
  pinTab: (id: string) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  updateTabScroll: (id: string, scrollPos: number) => void;

  // ─── Navigation history actions ───
  /** Push a path to nav history (called when navigating via link click) */
  navPush: (path: string) => void;
  /** Go back in navigation history */
  navBack: () => string | null;
  /** Go forward in navigation history */
  navForward: () => string | null;
  /** Check if can go back/forward */
  canNavBack: () => boolean;
  canNavForward: () => boolean;

  // ─── Multi-select actions ───
  /** Toggle select mode on/off */
  toggleSelectMode: () => void;
  /** Toggle a single path's selection (Ctrl+Click) */
  toggleSelectPath: (path: string) => void;
  /** Range select from lastClickedPath to given path (Shift+Click) */
  rangeSelectTo: (path: string, flatPaths: string[]) => void;
  /** Bulk add or remove paths (for folder select/deselect) */
  bulkTogglePaths: (paths: string[], selected: boolean) => void;
  /** Clear all selections */
  clearSelection: () => void;
  /** Set last clicked path (for Shift range base) */
  setLastClickedPath: (path: string) => void;
  /** Store paths for a later paste into a folder */
  setFileClipboard: (paths: string[]) => void;
  /** Clear the in-app file clipboard */
  clearFileClipboard: () => void;
}

// Hydrate tabs from localStorage once at module load. openFile mirrors the
// active tab so the file viewer renders immediately on restore.
const _persistedTabs = loadPersistedTabs();
const _activeFileTab = _persistedTabs.activeTabId
  ? _persistedTabs.tabs.find((t) => t.id === _persistedTabs.activeTabId) ?? null
  : null;
const _initialOpenFile: OpenFile | null = _activeFileTab
  ? {
      path: _activeFileTab.path,
      content: _activeFileTab.content,
      language: _activeFileTab.language,
      modified: _activeFileTab.modified,
      encoding: _activeFileTab.encoding,
    }
  : null;

export const useFileStore = create<FileState>((set, get) => ({
  tree: [],
  treeRoot: '',
  expandedPaths: loadExpandedPaths(),
  openFile: _initialOpenFile,
  contextPanelOpen: false,
  contextPanelExpanded: false,
  contextPanelTab: 'preview',
  splitTabId: null,
  splitOrientation: 'right',
  activeFilePane: 'main',
  lastOpenedFilePath: _activeFileTab?.path ?? null,
  originalContent: _activeFileTab?.content ?? null,
  externalChange: null,
  refreshTrigger: 0,
  expandedProjects: loadExpandedProjects(),
  showHidden: loadShowHidden(),
  projectSortMode: loadProjectSortMode(),
  fileSortMode: loadEntrySortMode(),
  projectTrees: {},
  projectLoaded: {},
  sidebarScroll: {},

  // ─── Tab state (hydrated from localStorage at module load) ───
  tabs: _persistedTabs.tabs,
  activeTabId: _persistedTabs.activeTabId,
  chatTabs: _persistedTabs.chatTabs,
  systemTabs: _persistedTabs.systemTabs,
  activeSystemTabId: _persistedTabs.activeSystemTabId,
  tabOrder: _persistedTabs.tabOrder,

  // ─── Navigation history ───
  navHistory: [],
  navIndex: -1,

  // ─── Multi-select state ───
  selectedPaths: new Set(),
  selectMode: false,
  lastClickedPath: null,
  fileClipboard: null,

  setTree: (entries) => {
    const { expandedPaths } = get();
    // Restore expanded state from persisted set
    const restored = applyExpandedState(entries, expandedPaths);
    set({ tree: restored });
  },

  setTreeRoot: (path) => set({ treeRoot: path }),
  setOpenFile: (file) => {
    if (file) {
      // Delegate to openTab for tab system integration
      get().openTab(file.path, file.content, file.language, file.encoding);
    } else {
      // Close active tab
      const { activeTabId } = get();
      if (activeTabId) {
        get().closeTab(activeTabId);
      } else {
        set({ openFile: null, contextPanelOpen: false, contextPanelExpanded: false, originalContent: null, externalChange: null });
      }
    }
  },
  updateOpenFileContent: (content) => {
    const { activeTabId } = get();
    if (activeTabId) {
      get().updateTabContent(activeTabId, content);
    }
  },
  setContextPanelOpen: (open) => set((s) => {
    if (!open) return { contextPanelOpen: false, activeFilePane: s.activeFilePane === 'extra' ? 'main' : s.activeFilePane };
    const nextSplitTabId = s.splitTabId ?? s.tabs.find((tab) => tab.pane === 'extra')?.id ?? null;
    return nextSplitTabId ? { contextPanelOpen: true, splitTabId: nextSplitTabId, splitOrientation: 'right' } : { contextPanelOpen: false };
  }),
  setContextPanelExpanded: (expanded) => set({ contextPanelExpanded: expanded, splitOrientation: 'right' }),
  setContextPanelTab: (tab) => set({ contextPanelTab: tab }),
  setActiveFilePane: (pane) => set((s) => (pane === 'extra' && !s.splitTabId ? { activeFilePane: 'main' } : { activeFilePane: pane })),
  openSplitTab: (tabId, _orientation) => set((s) => {
    // Viewer Pane can hold multiple file tabs. splitTabId is the active viewer
    // tab for rendering/legacy compatibility, not the whole viewer-tab set.
    const tabIndex = s.tabs.findIndex(t => t.id === tabId);
    const tab = s.tabs[tabIndex];
    if (!tab) return {};
    const nextTabs = s.tabs.map((t) => ({ ...t, pane: t.id === tabId ? 'extra' as const : (t.pane ?? 'main' as const) }));
    const remainingMain = mainFileTabs(nextTabs, tabId);
    const nextActive = s.activeTabId === tabId || (s.activeTabId && tabPane(nextTabs.find(t => t.id === s.activeTabId), tabId) === 'extra')
      ? (remainingMain[Math.min(tabIndex, remainingMain.length - 1)]?.id ?? null)
      : s.activeTabId;
    const nextActiveTab = nextActive ? nextTabs.find(t => t.id === nextActive) : null;
    return {
      tabs: nextTabs,
      splitTabId: tabId,
      splitOrientation: 'right',
      activeFilePane: 'extra',
      contextPanelOpen: true,
      contextPanelExpanded: false,
      activeTabId: nextActive,
      openFile: nextActiveTab
        ? { path: nextActiveTab.path, content: nextActiveTab.content, language: nextActiveTab.language, modified: nextActiveTab.modified, encoding: nextActiveTab.encoding }
        : null,
      originalContent: nextActiveTab?.content ?? null,
      lastOpenedFilePath: tab.path,
    };
  }),
  moveTabToPane: (tabId, pane, options) => {
    if (pane === 'extra') {
      get().openSplitTab(tabId, 'right');
      return;
    }
    if (get().splitTabId === tabId) {
      get().returnSplitTabToMain();
      return;
    }
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab) return {};
      return {
        tabs: s.tabs.map((t) => t.id === tabId ? { ...t, pane: 'main' as const } : t),
        activeFilePane: 'main',
        activeTabId: tabId,
          activeSystemTabId: null,
        openFile: { path: tab.path, content: tab.content, language: tab.language, modified: tab.modified, encoding: tab.encoding },
        originalContent: tab.content,
      };
    });
  },
  closeSplitTab: () => set((s) => {
    const activeExtraId = s.splitTabId;
    if (!activeExtraId) return { activeFilePane: 'main', contextPanelOpen: false, contextPanelExpanded: false };
    const tabs = s.tabs.map((t) => t.id === activeExtraId ? { ...t, pane: 'main' as const } : t);
    const nextExtra = tabs.find((t) => t.pane === 'extra') ?? null;
    return {
      tabs,
      splitTabId: nextExtra?.id ?? null,
      activeFilePane: nextExtra ? 'extra' : 'main',
      contextPanelOpen: !!nextExtra,
      contextPanelExpanded: nextExtra ? s.contextPanelExpanded : false,
    };
  }),
  returnSplitTabToMain: () => set((s) => {
    const tabId = s.splitTabId;
    if (!tabId) return {};
    const tab = s.tabs.find(t => t.id === tabId);
    const nextTabs = s.tabs.map((t) => t.id === tabId ? { ...t, pane: 'main' as const } : t);
    const nextExtra = nextTabs.find((t) => t.pane === 'extra') ?? null;
    return {
      splitTabId: nextExtra?.id ?? null,
      splitOrientation: 'right',
      activeFilePane: 'main',
      tabs: nextTabs,
      activeTabId: tabId,
      activeSystemTabId: null,
      contextPanelOpen: !!nextExtra,
      contextPanelExpanded: nextExtra ? s.contextPanelExpanded : false,
      openFile: tab ? { path: tab.path, content: tab.content, language: tab.language, modified: tab.modified, encoding: tab.encoding } : s.openFile,
      originalContent: tab?.content ?? s.originalContent,
      lastOpenedFilePath: tab?.path ?? s.lastOpenedFilePath,
    };
  }),

  markSaved: () => {
    const { activeTabId } = get();
    if (activeTabId) {
      get().markTabSaved(activeTabId);
    } else {
      set((s) => s.openFile
        ? { openFile: { ...s.openFile, modified: false }, originalContent: s.openFile.content }
        : {});
    }
  },

  setExternalChange: (change) => set({ externalChange: change }),

  reloadFromDisk: (content) =>
    set((s) => {
      const update: any = s.openFile
        ? { openFile: { ...s.openFile, content, modified: false }, originalContent: content, externalChange: null }
        : {};
      // Sync active tab
      if (s.activeTabId) {
        update.tabs = s.tabs.map(t =>
          t.id === s.activeTabId ? { ...t, content, modified: false } : t
        );
      }
      return update;
    }),

  keepLocalEdits: () => set({ externalChange: null }),

  toggleDirectory: (dirPath) =>
    set((s) => {
      const newTree = toggleDir(s.tree, dirPath);
      // Update persisted expanded paths
      const newExpanded = new Set(s.expandedPaths);
      if (newExpanded.has(dirPath)) {
        newExpanded.delete(dirPath);
      } else {
        newExpanded.add(dirPath);
      }
      saveExpandedPaths(newExpanded);
      return { tree: newTree, expandedPaths: newExpanded };
    }),

  setDirectoryChildren: (dirPath, children) =>
    set((s) => {
      // Apply expanded state to children as well
      const restoredChildren = applyExpandedState(children, s.expandedPaths);
      const newTree = setChildren(s.tree, dirPath, restoredChildren);
      // Ensure this dir is marked expanded
      const newExpanded = new Set(s.expandedPaths);
      newExpanded.add(dirPath);
      saveExpandedPaths(newExpanded);
      return { tree: newTree, expandedPaths: newExpanded };
    }),

  setDirectoryLoading: (dirPath, loading) =>
    set((s) => ({
      tree: setLoading(s.tree, dirPath, loading),
    })),

  handleFileChange: (event, filePath) => {
    const state = get();
    if (event === 'unlink' || event === 'unlinkDir') {
      // Remove from tree and expanded paths
      const newExpanded = new Set(state.expandedPaths);
      newExpanded.delete(filePath);
      saveExpandedPaths(newExpanded);
      set({ tree: removeFromTree(state.tree, filePath), expandedPaths: newExpanded });
    }
  },

  bumpRefreshTrigger: () => set((s) => ({ refreshTrigger: s.refreshTrigger + 1 })),

  toggleProjectExpanded: (projectId) =>
    set((s) => {
      const newSet = new Set(s.expandedProjects);
      if (newSet.has(projectId)) {
        newSet.delete(projectId);
      } else {
        newSet.add(projectId);
      }
      saveExpandedProjects(newSet);
      return { expandedProjects: newSet };
    }),

  isProjectExpanded: (projectId) => get().expandedProjects.has(projectId),

  toggleShowHidden: () =>
    set((s) => {
      const next = !s.showHidden;
      saveShowHidden(next);
      return { showHidden: next, refreshTrigger: s.refreshTrigger + 1 };
    }),

  setProjectSortMode: (mode) => {
    saveProjectSortMode(mode);
    set({ projectSortMode: mode });
  },

  setFileSortMode: (mode) => {
    saveEntrySortMode(mode);
    set({ fileSortMode: mode });
  },

  // ─── Per-project tree cache ───
  setProjectTree: (projectId, entries) =>
    set((s) => ({
      projectTrees: { ...s.projectTrees, [projectId]: entries },
    })),

  updateProjectTree: (projectId, updater) =>
    set((s) => {
      const prev = s.projectTrees[projectId] || [];
      const next = updater(prev);
      if (next === prev) return {};
      return { projectTrees: { ...s.projectTrees, [projectId]: next } };
    }),

  markProjectLoaded: (projectId, loaded) =>
    set((s) => ({
      projectLoaded: { ...s.projectLoaded, [projectId]: loaded },
    })),

  addExpandedPath: (path) =>
    set((s) => {
      if (s.expandedPaths.has(path)) return {};
      const next = new Set(s.expandedPaths);
      next.add(path);
      saveExpandedPaths(next);
      return { expandedPaths: next };
    }),

  removeExpandedPath: (path) =>
    set((s) => {
      if (!s.expandedPaths.has(path)) return {};
      const next = new Set(s.expandedPaths);
      next.delete(path);
      saveExpandedPaths(next);
      return { expandedPaths: next };
    }),

  setSidebarScroll: (tab, scrollTop) =>
    set((s) => ({
      sidebarScroll: { ...s.sidebarScroll, [tab]: scrollTop },
    })),

  // ─── Tab actions ───
  // Single click → replaces the unpinned (temporary) tab
  // Double click or edit → pins the tab so it won't be replaced
  // forceNew (shift/middle-click) → never replace, always push new tab
  // TAB_CAP=6 enforced via LRU on unpinned tabs (pinned preserved)
  // contextPanelOpen NOT auto-set — file tabs now render in the main body via
  // FileTabBar+MainTabbedContent. The right ContextPanel is legacy/coexisting
  // and only opens on explicit user toggle. See:
  //   workspace/decisions/2026-05-22-global-multi-tab-shell.md
  openTab: (path, content, language, encoding, options) => set((s) => {
    const TAB_CAP = 6;
    const forceNew = options?.forceNew ?? false;
    const backgroundSplit = options?.backgroundSplit ?? false;

    const openInExtra = !!options?.split || (s.activeFilePane === 'extra' && !!s.splitTabId);

    // Already open → focus the selected file pane. If the caller just read the
    // file from disk (e.g. clicking a file link after refresh), also refresh the
    // existing tab content unless the user has unsaved local edits.
    // If the viewer pane is active, "focus" means send/keep that tab in the viewer
    // pane instead of stealing the main pane.
    const existing = s.tabs.find(t => t.path === path && (openInExtra || t.id !== s.splitTabId));
    if (existing) {
      const refreshedExisting = existing.modified
        ? existing
        : { ...existing, content, language, encoding, modified: false };
      const tabs = refreshedExisting === existing
        ? s.tabs
        : s.tabs.map((t) => (t.id === existing.id ? refreshedExisting : t));
      if (openInExtra) {
        // The Viewer keeps one preview slot: pinned tabs survive, while any
        // other temporary Viewer tabs are discarded even when restoring from
        // legacy state that already accumulated several of them.
        const nextTabs = tabs
          .filter((t) => t.id === existing.id || t.pinned || tabPane(t, s.splitTabId) !== 'extra')
          .map((t) => ({ ...t, pane: t.id === existing.id ? 'extra' as const : (t.pane ?? 'main' as const) }));
        return {
          tabs: nextTabs,
          tabOrder: normalizeTabOrder(s.chatTabs, nextTabs, s.systemTabs, s.tabOrder),
          splitTabId: backgroundSplit ? s.splitTabId : existing.id,
          splitOrientation: 'right',
          activeFilePane: backgroundSplit ? s.activeFilePane : 'extra',
          contextPanelOpen: backgroundSplit ? s.contextPanelOpen : true,
          lastOpenedFilePath: refreshedExisting.path,
        };
      }
      return {
        tabs,
        activeFilePane: 'main',
        activeTabId: existing.id,
          activeSystemTabId: null,
        openFile: { path: refreshedExisting.path, content: refreshedExisting.content, language: refreshedExisting.language, modified: refreshedExisting.modified, encoding: refreshedExisting.encoding },
        lastOpenedFilePath: refreshedExisting.path,
        originalContent: refreshedExisting.modified ? s.originalContent : refreshedExisting.content,
        externalChange: s.externalChange?.path === path && !refreshedExisting.modified ? null : s.externalChange,
      };
    }

    let newTab: FileTab = {
      id: crypto.randomUUID(),
      path,
      content,
      language,
      modified: false,
      encoding,
      name: options?.name,
      pinned: false,  // new tabs start as temporary
      pane: openInExtra ? 'extra' : 'main',
    };

    let newTabs: FileTab[];
    if (openInExtra) {
      // Viewer invariant: pinned tabs form the durable working set and there is
      // exactly one optional unpinned preview slot. Reuse the active preview's
      // id so a background present_file can replace its contents without
      // invalidating the current Viewer selection.
      const activePreview = s.tabs.find((t) => t.id === s.splitTabId && !t.pinned && tabPane(t, s.splitTabId) === 'extra');
      const firstPreview = activePreview ?? s.tabs.find((t) => !t.pinned && tabPane(t, s.splitTabId) === 'extra');
      if (firstPreview) newTab = { ...newTab, id: firstPreview.id };
      newTabs = s.tabs.filter((t) => t.pinned || tabPane(t, s.splitTabId) !== 'extra');
      const insertAt = firstPreview ? Math.min(s.tabs.indexOf(firstPreview), newTabs.length) : newTabs.length;
      newTabs.splice(insertAt, 0, newTab);
    } else if (forceNew) {
      // shift/middle-click — always push, never replace
      newTabs = [...s.tabs, newTab];
    } else {
      // Normal click — replace an unpinned preview tab in the main pane.
      // Pinned tabs are the user's explicit working set and must be preserved.
      const tempIdx = s.tabs.findIndex(t => !t.pinned && tabPane(t, s.splitTabId) === 'main');
      if (tempIdx !== -1) {
        newTabs = [...s.tabs];
        newTabs[tempIdx] = newTab;
      } else {
        // All tabs in the main pane are pinned — add a new temporary tab.
        newTabs = [...s.tabs, newTab];
      }
    }

    // TAB_CAP enforcement — LRU on unpinned, preserve pinned
    // (If all 6 are pinned, allow overflow — user explicitly pinned them.)
    while (newTabs.length > TAB_CAP) {
      const oldestUnpinnedIdx = newTabs.findIndex(t => !t.pinned && t.id !== newTab.id && tabPane(t, openInExtra ? newTab.id : s.splitTabId) === 'main');
      if (oldestUnpinnedIdx === -1) break;
      newTabs = newTabs.filter((_, i) => i !== oldestUnpinnedIdx);
    }

    const finalTabs = openInExtra
      ? newTabs.map((t) => ({ ...t, pane: t.id === newTab.id ? 'extra' as const : (t.pane ?? 'main' as const) }))
      : newTabs.map((t) => t.id === newTab.id ? { ...t, pane: 'main' as const } : t);

    return {
      tabs: finalTabs,
      tabOrder: normalizeTabOrder(s.chatTabs, finalTabs, s.systemTabs, [...s.tabOrder.filter((i) => i.kind !== 'file' || finalTabs.some((t) => t.id === i.id)), { kind: 'file', id: newTab.id }]),
      splitTabId: openInExtra && !backgroundSplit ? newTab.id : s.splitTabId,
      splitOrientation: openInExtra ? 'right' : s.splitOrientation,
      contextPanelOpen: openInExtra && !backgroundSplit ? true : s.contextPanelOpen,
      activeFilePane: openInExtra && !backgroundSplit ? 'extra' : s.activeFilePane,
      activeTabId: openInExtra ? s.activeTabId : newTab.id,
      activeSystemTabId: openInExtra ? s.activeSystemTabId : null,
      openFile: openInExtra ? s.openFile : { path, content, language, modified: false, encoding },
      lastOpenedFilePath: path,
      originalContent: openInExtra ? s.originalContent : content,
      externalChange: null,
    };
  }),

  activateChatSlot: () => set({ activeTabId: null, activeSystemTabId: null, activeFilePane: 'main' }),


  openSystemTab: (kind, options) => set((s) => {
    const refId = options?.refId;
    if (kind === 'projectFiles' && !refId) return s;
    const forceNew = options?.forceNew ?? false;
    const existing = !forceNew ? s.systemTabs.find((t) => t.kind === kind && (t.refId || '') === (refId || '')) : undefined;
    if (existing) {
      return { activeTabId: null, activeSystemTabId: existing.id, activeFilePane: 'main' };
    }
    const pinned = options?.pinned ?? kind === 'publishing';
    let newTab: SystemTab = {
      id: crypto.randomUUID(),
      kind,
      refId,
      title: options?.title || (kind === 'publishing' ? 'Publishing Hub' : kind === 'projectFiles' ? '프로젝트 홈' : '스케줄'),
      icon: options?.icon || (kind === 'publishing' ? '🌐' : kind === 'projectFiles' ? '📁' : '⏰'),
      pinned,
    };
    let newSystemTabs: SystemTab[];
    if (!forceNew && !pinned) {
      const previewIdx = s.systemTabs.findIndex((tab) => tab.kind === kind && !tab.pinned);
      if (previewIdx !== -1) {
        newTab = { ...newTab, id: s.systemTabs[previewIdx].id };
        newSystemTabs = [...s.systemTabs];
        newSystemTabs[previewIdx] = newTab;
      } else {
        newSystemTabs = [...s.systemTabs, newTab];
      }
    } else {
      newSystemTabs = [...s.systemTabs, newTab];
    }
    return {
      systemTabs: newSystemTabs,
      tabOrder: normalizeTabOrder(s.chatTabs, s.tabs, newSystemTabs, [...s.tabOrder.filter((i) => i.kind !== 'system' || newSystemTabs.some((t) => t.id === i.id)), { kind: 'system', id: newTab.id }]),
      activeTabId: null,
      activeSystemTabId: newTab.id,
      activeFilePane: 'main',
    };
  }),

  closeSystemTab: (id) => set((s) => {
    const newSystemTabs = s.systemTabs.filter((t) => t.id !== id);
    const isActive = s.activeSystemTabId === id;
    const fallbackFile = isActive ? s.tabs[0] : null;
    return {
      systemTabs: newSystemTabs,
      tabOrder: normalizeTabOrder(s.chatTabs, s.tabs, newSystemTabs, s.tabOrder),
      activeSystemTabId: isActive ? null : s.activeSystemTabId,
      activeTabId: isActive && fallbackFile ? fallbackFile.id : s.activeTabId,
      openFile: isActive && fallbackFile ? { path: fallbackFile.path, content: fallbackFile.content, language: fallbackFile.language, modified: fallbackFile.modified, encoding: fallbackFile.encoding } : s.openFile,
    };
  }),

  pinSystemTab: (id) => set((s) => ({
    systemTabs: s.systemTabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)),
  })),

  activateSystemTab: (id) => set((s) => {
    if (!s.systemTabs.some((t) => t.id === id)) return {};
    return { activeTabId: null, activeSystemTabId: id, activeFilePane: 'main' };
  }),

  // ─── Chat tab actions (v3, path B — see ChatTab doc above) ───
  openChatTab: (sessionId, options) => set((s) => {
    const CHAT_CAP = 6;
    const forceNew = options?.forceNew ?? false;

    // Already open → just enter chat mode (no list change).
    if (s.chatTabs.some((t) => t.sessionId === sessionId)) {
      return { activeTabId: null, activeSystemTabId: null, activeFilePane: 'main' };
    }

    const newTab: ChatTab = { id: crypto.randomUUID(), sessionId, pinned: false };
    const activeSessionId = useSessionStore.getState().activeSessionId;

    let newChatTabs: ChatTab[];
    if (forceNew) {
      newChatTabs = [...s.chatTabs, newTab];
    } else {
      // Replace the active unpinned (temporary) chat tab. The "active" chat tab
      // is the one matching the current activeSessionId (set just before this
      // call returns, in handleSelectSession). Mirrors file openTab semantics.
      let replaceIdx = s.chatTabs.findIndex((t) => !t.pinned && t.sessionId === activeSessionId);
      if (replaceIdx === -1) replaceIdx = s.chatTabs.findIndex((t) => !t.pinned);
      if (replaceIdx !== -1) {
        newChatTabs = [...s.chatTabs];
        newChatTabs[replaceIdx] = newTab;
      } else {
        newChatTabs = [...s.chatTabs, newTab];
      }
    }

    // CHAT_CAP enforcement — LRU on unpinned (preserve pinned + the new tab).
    while (newChatTabs.length > CHAT_CAP) {
      const oldestUnpinnedIdx = newChatTabs.findIndex((t) => !t.pinned && t.id !== newTab.id);
      if (oldestUnpinnedIdx === -1) break;
      newChatTabs = newChatTabs.filter((_, i) => i !== oldestUnpinnedIdx);
    }

    return {
      chatTabs: newChatTabs,
      tabOrder: normalizeTabOrder(newChatTabs, s.tabs, s.systemTabs, [...s.tabOrder.filter((i) => i.kind !== 'chat' || newChatTabs.some((t) => t.id === i.id)), { kind: 'chat', id: newTab.id }]),
      activeTabId: null,
      activeSystemTabId: null,
    };
  }),

  closeChatTab: (id) => {
    const s = get();
    const tab = s.chatTabs.find((t) => t.id === id);
    if (!tab) return null;
    const newChatTabs = s.chatTabs.filter((t) => t.id !== id);
    if (!newChatTabs.some((candidate) => candidate.sessionId === tab.sessionId)) {
      clearSessionViewportSnapshot(tab.sessionId);
    }
    const activeSessionId = useSessionStore.getState().activeSessionId;
    let nextSessionId: string | null = null;
    // Closing the active chat tab while in chat mode → activate the adjacent one.
    if (tab.sessionId === activeSessionId && s.activeTabId === null && !s.activeSystemTabId && newChatTabs.length > 0) {
      const closedIdx = s.chatTabs.findIndex((t) => t.id === id);
      const nextIdx = Math.min(closedIdx, newChatTabs.length - 1);
      nextSessionId = newChatTabs[nextIdx].sessionId;
    }
    const isClosingActiveChat = tab.sessionId === activeSessionId && s.activeTabId === null && !s.activeSystemTabId;
    const nextState: Partial<FileState> = {
      chatTabs: newChatTabs,
      tabOrder: normalizeTabOrder(newChatTabs, s.tabs, s.systemTabs, s.tabOrder),
    };
    if (isClosingActiveChat && newChatTabs.length === 0) {
      const fallbackFile = s.tabs.find((t) => t.id !== s.splitTabId) ?? s.tabs[0] ?? null;
      if (fallbackFile) {
        nextState.activeTabId = fallbackFile.id;
        nextState.activeSystemTabId = null;
        nextState.activeFilePane = 'main';
        nextState.openFile = { path: fallbackFile.path, content: fallbackFile.content, language: fallbackFile.language, modified: fallbackFile.modified, encoding: fallbackFile.encoding };
        nextState.originalContent = fallbackFile.content;
        nextState.lastOpenedFilePath = fallbackFile.path;
      }
    }
    set(nextState);
    return nextSessionId;
  },

  pinChatTab: (id) => set((s) => ({
    chatTabs: s.chatTabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)),
  })),

  reorderTabOrder: (activeKey, overKey) => set((s) => {
    if (activeKey === overKey) return {};
    const current = normalizeTabOrder(s.chatTabs, s.tabs, s.systemTabs, s.tabOrder);
    const from = current.findIndex((i) => `${i.kind}:${i.id}` === activeKey);
    const to = current.findIndex((i) => `${i.kind}:${i.id}` === overKey);
    if (from < 0 || to < 0) return {};
    const next = [...current];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return { tabOrder: next };
  }),

  updateChatTabScroll: (sessionId, snapshot) => set((s) => {
    let changed = false;
    const chatTabs = s.chatTabs.map((t) => {
      if (t.sessionId !== sessionId) return t;
      const next = { ...t, ...snapshot };
      if (
        next.scrollTop !== t.scrollTop ||
        next.topVisibleIndex !== t.topVisibleIndex ||
        next.atBottom !== t.atBottom
      ) {
        changed = true;
        return next;
      }
      return t;
    });
    return changed ? { chatTabs } : {};
  }),

  closeTab: (id) => set((s) => {
    const tab = s.tabs.find(t => t.id === id);
    if (!tab) return {};

    const newTabs = s.tabs.filter(t => t.id !== id);
    const closingExtra = tabPane(tab, s.splitTabId) === 'extra';
    const nextExtra = closingExtra ? newTabs.find(t => t.pane === 'extra') ?? null : (s.splitTabId ? newTabs.find(t => t.id === s.splitTabId) ?? null : null);
    const nextSplitTabId = closingExtra && s.splitTabId === id ? nextExtra?.id ?? null : (s.splitTabId === id ? null : s.splitTabId);
    const mainTabs = mainFileTabs(newTabs, nextSplitTabId);

    // If closing active tab, switch to adjacent main-pane tab (never to an extra-pane tab).
    let newActiveId = s.activeTabId;
    if (s.activeTabId === id || (newActiveId && tabPane(newTabs.find(t => t.id === newActiveId), nextSplitTabId) === 'extra')) {
      if (mainTabs.length === 0) {
        newActiveId = null;
      } else {
        const closedIdx = s.tabs.findIndex(t => t.id === id);
        const nextIdx = Math.min(Math.max(closedIdx, 0), mainTabs.length - 1);
        newActiveId = mainTabs[nextIdx].id;
      }
    }

    const activeTab = newActiveId ? newTabs.find(t => t.id === newActiveId) : null;

    return {
      tabs: newTabs,
      tabOrder: normalizeTabOrder(s.chatTabs, newTabs, s.systemTabs, s.tabOrder),
      activeTabId: newActiveId,
      activeSystemTabId: newActiveId ? null : s.activeSystemTabId,
      openFile: activeTab
        ? { path: activeTab.path, content: activeTab.content, language: activeTab.language, modified: activeTab.modified, encoding: activeTab.encoding }
        : null,
      contextPanelOpen: nextSplitTabId ? s.contextPanelOpen : false,
      contextPanelExpanded: nextSplitTabId ? s.contextPanelExpanded : false,
      splitTabId: nextSplitTabId,
      activeFilePane: closingExtra ? (nextSplitTabId ? 'extra' : 'main') : s.activeFilePane,
      originalContent: activeTab?.content ?? null,
    };
  }),

  closeOtherTabs: (id) => set((s) => {
    const keep = s.tabs.filter(t => t.id === id);
    const tab = keep[0];
    return {
      tabs: keep,
      tabOrder: normalizeTabOrder(s.chatTabs, keep, s.systemTabs, s.tabOrder),
      activeTabId: id,
      activeSystemTabId: null,
      openFile: tab ? { path: tab.path, content: tab.content, language: tab.language, modified: tab.modified, encoding: tab.encoding } : s.openFile,
      splitTabId: s.splitTabId === id ? s.splitTabId : null,
      activeFilePane: s.splitTabId === id ? 'extra' : 'main',
      contextPanelOpen: s.splitTabId === id,
      contextPanelExpanded: s.splitTabId === id ? s.contextPanelExpanded : false,
    };
  }),

  closeAllTabs: () => set((s) => ({
    tabs: [],
    tabOrder: normalizeTabOrder(s.chatTabs, [], s.systemTabs, s.tabOrder),
    activeTabId: null,
    openFile: null,
    contextPanelOpen: false,
    contextPanelExpanded: false,
    splitTabId: null,
    activeFilePane: 'main',
    originalContent: null,
  })),

  setActiveTab: (id) => set((s) => {
    const tab = s.tabs.find(t => t.id === id);
    if (!tab) return {};
    return {
      activeFilePane: 'main',
      activeTabId: id,
      activeSystemTabId: null,
      openFile: { path: tab.path, content: tab.content, language: tab.language, modified: tab.modified, encoding: tab.encoding },
      lastOpenedFilePath: tab.path,
      originalContent: tab.content,
      contextPanelExpanded: ['html', 'pdf', 'image', 'video'].includes(tab.language),
    };
  }),

  updateTabContent: (id, content) => set((s) => {
    const newTabs = s.tabs.map(t => {
      if (t.id !== id) return t;
      const modified = content !== s.originalContent;
      // Editing auto-pins the tab
      return { ...t, content, modified, pinned: true };
    });
    const activeTab = newTabs.find(t => t.id === s.activeTabId);
    return {
      tabs: newTabs,
      openFile: s.activeTabId === id && activeTab
        ? { path: activeTab.path, content: activeTab.content, language: activeTab.language, modified: activeTab.modified, encoding: activeTab.encoding }
        : s.openFile,
    };
  }),

  renameOpenTabPath: (oldPath, newPath, name) => set((s) => ({
    tabs: s.tabs.map((tab) => tab.path === oldPath ? { ...tab, path: newPath, name: name ?? tab.name } : tab),
    openFile: s.openFile?.path === oldPath ? { ...s.openFile, path: newPath } : s.openFile,
    lastOpenedFilePath: s.lastOpenedFilePath === oldPath ? newPath : s.lastOpenedFilePath,
    navHistory: s.navHistory.map((item) => item === oldPath ? newPath : item),
  })),

  updateTabContentByPath: (path, content) => set((s) => {
    let changed = false;
    const newTabs = s.tabs.map(t => {
      if (t.path !== path || t.modified) return t;
      changed = true;
      return { ...t, content, modified: false };
    });
    if (!changed) return {};
    const activeTab = s.activeTabId ? newTabs.find(t => t.id === s.activeTabId) : null;
    return {
      tabs: newTabs,
      openFile: activeTab
        ? { path: activeTab.path, content: activeTab.content, language: activeTab.language, modified: activeTab.modified, encoding: activeTab.encoding }
        : s.openFile,
      originalContent: activeTab?.path === path ? content : s.originalContent,
      externalChange: s.externalChange?.path === path ? null : s.externalChange,
    };
  }),

  pinTab: (id) => set((s) => ({
    // Toggle (pinChatTab 와 일관). 기존엔 set-true 라 메뉴 "고정 해제" 가 작동
    // 안 했음. 더블클릭/메뉴 양쪽 동일 토글 시맨틱.
    tabs: s.tabs.map(t => t.id === id ? { ...t, pinned: !t.pinned } : t),
  })),

  markTabSaved: (id) => set((s) => {
    const tab = s.tabs.find(t => t.id === id);
    if (!tab) return {};
    const newTabs = s.tabs.map(t =>
      t.id === id ? { ...t, modified: false } : t
    );
    return {
      tabs: newTabs,
      originalContent: tab.content,
      openFile: s.activeTabId === id
        ? { path: tab.path, content: tab.content, language: tab.language, modified: false, encoding: tab.encoding }
        : s.openFile,
    };
  }),

  markTabSavedByPath: (path) => set((s) => {
    const savedTab = s.tabs.find(t => t.path === path);
    if (!savedTab) return {};
    const newTabs = s.tabs.map(t => t.path === path ? { ...t, modified: false } : t);
    const activeTab = s.activeTabId ? newTabs.find(t => t.id === s.activeTabId) : null;
    return {
      tabs: newTabs,
      originalContent: activeTab?.path === path ? activeTab.content : s.originalContent,
      openFile: activeTab
        ? { path: activeTab.path, content: activeTab.content, language: activeTab.language, modified: activeTab.modified, encoding: activeTab.encoding }
        : s.openFile,
    };
  }),

  reorderTabs: (fromIndex, toIndex) => set((s) => {
    const newTabs = [...s.tabs];
    const [moved] = newTabs.splice(fromIndex, 1);
    newTabs.splice(toIndex, 0, moved);
    return { tabs: newTabs };
  }),

  updateTabScroll: (id, scrollPos) => set((s) => ({
    tabs: s.tabs.map(t => t.id === id ? { ...t, scrollPos } : t),
  })),

  // ─── Multi-select actions ───
  toggleSelectMode: () =>
    set((s) => {
      const next = !s.selectMode;
      if (!next) {
        // Exiting select mode → clear selections
        return { selectMode: false, selectedPaths: new Set(), lastClickedPath: null };
      }
      return { selectMode: true };
    }),

  toggleSelectPath: (path) =>
    set((s) => {
      const next = new Set(s.selectedPaths);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return { selectedPaths: next, lastClickedPath: path };
    }),

  rangeSelectTo: (path, flatPaths) =>
    set((s) => {
      const anchor = s.lastClickedPath;
      if (!anchor) {
        // No anchor — just select the clicked path
        const next = new Set(s.selectedPaths);
        next.add(path);
        return { selectedPaths: next, lastClickedPath: path };
      }
      const startIdx = flatPaths.indexOf(anchor);
      const endIdx = flatPaths.indexOf(path);
      if (startIdx === -1 || endIdx === -1) {
        const next = new Set(s.selectedPaths);
        next.add(path);
        return { selectedPaths: next, lastClickedPath: path };
      }
      const lo = Math.min(startIdx, endIdx);
      const hi = Math.max(startIdx, endIdx);
      const next = new Set(s.selectedPaths);
      for (let i = lo; i <= hi; i++) {
        next.add(flatPaths[i]);
      }
      return { selectedPaths: next };
    }),

  bulkTogglePaths: (paths, selected) =>
    set((s) => {
      const next = new Set(s.selectedPaths);
      for (const p of paths) {
        if (selected) next.add(p); else next.delete(p);
      }
      return { selectedPaths: next };
    }),

  clearSelection: () =>
    set({ selectedPaths: new Set(), lastClickedPath: null }),

  setLastClickedPath: (path) =>
    set({ lastClickedPath: path }),

  setFileClipboard: (paths) =>
    set({ fileClipboard: { paths: [...new Set(paths)], copiedAt: Date.now() } }),

  clearFileClipboard: () =>
    set({ fileClipboard: null }),

  // ─── Navigation history ───
  navPush: (path) => set((s) => {
    // If same as current position, skip
    if (s.navIndex >= 0 && s.navHistory[s.navIndex] === path) return {};
    // Truncate forward history and push new path
    const newHistory = [...s.navHistory.slice(0, s.navIndex + 1), path];
    // Limit history size to 50
    const trimmed = newHistory.length > 50 ? newHistory.slice(-50) : newHistory;
    return { navHistory: trimmed, navIndex: trimmed.length - 1 };
  }),

  navBack: () => {
    const s = get();
    if (s.navIndex <= 0) return null;
    const newIndex = s.navIndex - 1;
    const path = s.navHistory[newIndex];
    set({ navIndex: newIndex });
    return path;
  },

  navForward: () => {
    const s = get();
    if (s.navIndex >= s.navHistory.length - 1) return null;
    const newIndex = s.navIndex + 1;
    const path = s.navHistory[newIndex];
    set({ navIndex: newIndex });
    return path;
  },

  canNavBack: () => {
    const s = get();
    return s.navIndex > 0;
  },

  canNavForward: () => {
    const s = get();
    return s.navIndex < s.navHistory.length - 1;
  },
}));

function toggleDir(entries: FileEntry[], dirPath: string): FileEntry[] {
  return entries.map((e) => {
    if (e.path === dirPath) {
      return { ...e, isExpanded: !e.isExpanded };
    }
    if (e.children) {
      return { ...e, children: toggleDir(e.children, dirPath) };
    }
    return e;
  });
}

function setChildren(entries: FileEntry[], dirPath: string, children: FileEntry[]): FileEntry[] {
  return entries.map((e) => {
    if (e.path === dirPath) {
      return { ...e, children, isExpanded: true, isLoading: false };
    }
    if (e.children) {
      return { ...e, children: setChildren(e.children, dirPath, children) };
    }
    return e;
  });
}

function setLoading(entries: FileEntry[], dirPath: string, loading: boolean): FileEntry[] {
  return entries.map((e) => {
    if (e.path === dirPath) {
      return { ...e, isLoading: loading };
    }
    if (e.children) {
      return { ...e, children: setLoading(e.children, dirPath, loading) };
    }
    return e;
  });
}

function removeFromTree(entries: FileEntry[], filePath: string): FileEntry[] {
  return entries
    .filter((e) => e.path !== filePath)
    .map((e) => {
      if (e.children) {
        return { ...e, children: removeFromTree(e.children, filePath) };
      }
      return e;
    });
}

// ─── Auto-persist tab state on change (debounced 300ms) ───
// 새 탭 추가/닫기/active 전환/내용 변경 등 매 상태 변화마다 한 번씩 저장.
// 다른 필드 변경(트리 expand 등) 은 무시 — reference equality 로 가르기.
{
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let prevTabs = useFileStore.getState().tabs;
  let prevChatTabs = useFileStore.getState().chatTabs;
  let prevSystemTabs = useFileStore.getState().systemTabs;
  let prevActiveTabId = useFileStore.getState().activeTabId;
  let prevActiveSystemTabId = useFileStore.getState().activeSystemTabId;
  let prevTabOrder = useFileStore.getState().tabOrder;
  useFileStore.subscribe((s) => {
    if (s.tabs === prevTabs && s.chatTabs === prevChatTabs && s.systemTabs === prevSystemTabs && s.activeTabId === prevActiveTabId && s.activeSystemTabId === prevActiveSystemTabId && s.tabOrder === prevTabOrder) return;
    prevTabs = s.tabs;
    prevChatTabs = s.chatTabs;
    prevSystemTabs = s.systemTabs;
    prevActiveTabId = s.activeTabId;
    prevActiveSystemTabId = s.activeSystemTabId;
    prevTabOrder = s.tabOrder;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      savePersistedTabs({ tabs: s.tabs, chatTabs: s.chatTabs, systemTabs: s.systemTabs, activeTabId: s.activeTabId, activeSystemTabId: s.activeSystemTabId, tabOrder: s.tabOrder });
      saveTimer = null;
    }, 300);
  });
}
