import { towerHttpUrl } from '../../features/client-connection/connection';
/**
 * Owns: 본문 상단 글로벌 탭 바.
 *   - 좌측 채팅 탭들 (useFileStore.chatTabs) — 세션 북마크, 동등 1급 시민
 *   - 우측 파일 탭들 (useFileStore.tabs) — modifier 패턴 + 6 cap + LRU
 *
 * Public API: <FileTabBar onSelectChatSession={(sessionId) => void} />
 * 데이터 모델 / 정책: workspace/decisions/2026-05-22-global-multi-tab-shell.md (v3)
 *
 * v3 (2026-05-24, path B): 채팅 세션도 멀티 탭으로 격상. 단 ChatPanel 은 탭당
 * mount 하지 않고 1개만 — 채팅 탭은 *북마크* 이고, 클릭 시 activeSessionId 를
 * 교체 (onSelectChatSession → App.handleSelectSession). "active 채팅 탭" =
 * activeTabId===null && tab.sessionId===activeSessionId.
 *
 * 인터랙션:
 *   채팅 탭:
 *     - 클릭          → onSelectChatSession(sessionId)  (세션 전환 + 채팅 모드)
 *     - middle-click  → closeChatTab(id)               (브라우저 관습)
 *     - double-click  → pinChatTab(id) toggle          (VS Code 식)
 *     - × 버튼        → closeChatTab(id)
 *     - 우클릭        → ContextMenu (닫기 / 고정·해제)
 *     - 탭 running → 작은 애니메이션 dot (자동 전환 X, dot 만)
 *     - 탭 awaiting_user → 말풍선 ? 배지 (사용자 응답 필요)
 *     - 백그라운드 탭 complete → 사용자가 다시 열 때까지 작은 check
 *   파일 탭: v2 그대로 (setActiveTab / closeTab / pinTab / 우클릭 메뉴)
 *
 * shift/middle-click 으로 *새 탭 강제 추가* 는 link 호출자 단계의 modifier
 * (Sidebar SessionItem → openChatTab forceNew, RichContent/file links →
 * openTab forceNew). 탭 바 자체에서는 해당 없음.
 */
import { findOwningProjectForPath, normalizeSidebarFilePath } from '../../utils/sidebar-file-owner';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { useFileStore, type FileEntry } from '../../stores/file-store';
import { useSessionStore } from '../../stores/session-store';
import { useAiPanelStore } from '../../stores/ai-panel-store';
import { useProjectStore } from '../../stores/project-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useChatStore } from '../../stores/chat-store';
import { deriveSessionRowActivity, deriveSessionRowState } from '../../features/session-run-state/session-row-state';
import { fmtTokensShort } from '../../utils/context-usage';
import { useModelStore } from '../../stores/model-store';
import { contextInputFromUsageOrRow, contextWindowForSession } from '../../utils/message-metrics';
import { toastQuiet } from '../../utils/toast';
import { usePrompt } from '../../hooks/useDialog';
import { AgentIdentityAvatar } from '../../features/agent-profile/AgentIdentityAvatar';
import { MainTab, MainTabCloseButton, MainTabPinButton } from './MainTab';
import { ShareModal } from '../files/ShareModal';
import { RunIndicator } from '../common/RunIndicator';

function getFileIcon(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'md': case 'markdown': return '📝';
    case 'pdf': return '📕';
    case 'xlsx': case 'xls': case 'csv': case 'tsv': return '📊';
    case 'docx': case 'doc': case 'hwp': return '📘';
    case 'pptx': case 'ppt': return '📙';
    case 'html': case 'htm': return '🌐';
    case 'json': case 'yaml': case 'yml': return '⚙️';
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'svg': return '🖼️';
    case 'ipynb': return '📓';
    case 'dxf': case 'dwg': return '📐';
    default: return '📄';
  }
}

function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

function normalizePath(path: string): string {
  return normalizeSidebarFilePath(path);
}

function isPathInsideRoot(path: string, rootPath: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(rootPath);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function getSidebarAncestorPaths(path: string, rootPath?: string | null): string[] {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = rootPath ? normalizePath(rootPath) : '';
  const parentPath = normalizedPath.includes('/') ? normalizedPath.slice(0, normalizedPath.lastIndexOf('/')) : '';
  if (!parentPath) return [];

  if (normalizedRoot && isPathInsideRoot(normalizedPath, normalizedRoot)) {
    const relativeParent = parentPath.slice(normalizedRoot.length).replace(/^\/+/, '');
    const segments = relativeParent.split('/').filter(Boolean);
    const paths: string[] = [];
    let acc = normalizedRoot;
    for (const segment of segments) {
      acc = `${acc}/${segment}`;
      paths.push(acc);
    }
    return paths;
  }

  const parts = parentPath.split('/').filter(Boolean);
  const paths: string[] = [];
  let acc = normalizedPath.startsWith('/') ? '' : '';
  for (const part of parts) {
    acc += `/${part}`;
    paths.push(acc);
  }
  return paths;
}

function formatSidebarLocation(path: string, project?: { name?: string; rootPath?: string | null }): string {
  const normalizedPath = normalizePath(path);
  if (project?.rootPath && isPathInsideRoot(normalizedPath, project.rootPath)) {
    const relative = normalizedPath.slice(normalizePath(project.rootPath).length).replace(/^\/+/, '');
    return [project.name || basename(project.rootPath), relative].filter(Boolean).join(' / ');
  }
  return normalizedPath;
}

type FileRevealResponse = {
  path: string;
  rootPath: string;
  targetDir: string;
  ancestors: string[];
  entriesByPath: Record<string, FileEntry[]>;
};

function mergeRevealEntries(
  rootEntries: FileEntry[],
  rootPath: string,
  ancestors: string[],
  entriesByPath: Record<string, FileEntry[]>,
): FileEntry[] {
  const normalizedEntriesByPath = new Map(
    Object.entries(entriesByPath).map(([dirPath, entries]) => [normalizePath(dirPath), entries]),
  );
  const expandedPaths = new Set(ancestors.map(normalizePath));

  const patchEntries = (entries: FileEntry[]): FileEntry[] => entries.map((entry) => {
    if (!entry.isDirectory) return entry;
    const normalizedEntryPath = normalizePath(entry.path);
    const revealedChildren = normalizedEntriesByPath.get(normalizedEntryPath);
    if (revealedChildren) {
      return {
        ...entry,
        isExpanded: expandedPaths.has(normalizedEntryPath),
        isLoading: false,
        children: patchEntries(revealedChildren),
      };
    }
    if (expandedPaths.has(normalizedEntryPath)) {
      return {
        ...entry,
        isExpanded: true,
        isLoading: false,
        children: entry.children ? patchEntries(entry.children) : entry.children,
      };
    }
    return entry;
  });

  return patchEntries(normalizedEntriesByPath.get(normalizePath(rootPath)) || rootEntries);
}

function AwaitingUserMark({ active }: { active?: boolean }) {
  const { t } = useTranslation('layout');
  return (
    <span
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[12px] font-bold leading-none ${
        active
          ? 'tone-warning tone-border tone-bg-soft tone-text'
          : 'tone-warning tone-border tone-bg-soft tone-text'
      }`}
      aria-label={t('awaitingReply')}
      title={t('aiNeedsReply')}
    >
      ?
    </span>
  );
}

interface CtxMenuState {
  x: number;
  y: number;
  kind: 'file' | 'chat' | 'system';
  id: string;
  pinned: boolean;
}

interface FileTabBarProps {
  /** Activate a chat tab by sessionId (switches active session + chat mode). */
  onSelectChatSession: (sessionId: string) => void;
  /** Rename a session from the tab context menu. */
  onRenameSession: (sessionId: string, name: string) => void;
  /** Re-read the current file from disk. */
  onReloadFile: (path: string) => void;
}

export function SortableTabShell({ id, children, className = '' }: { id: string; children: React.ReactNode; className?: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  // dnd-kit sortable transforms may include scaleX/scaleY while neighboring
  // items make room. For text-heavy tabs that visually stretches the title and
  // icons, so preserve only translation here.
  const translateOnlyTransform = transform
    ? DndCSS.Translate.toString({ x: transform.x, y: transform.y, scaleX: 1, scaleY: 1 })
    : undefined;
  return (
    <div
      ref={setNodeRef}
      data-main-tab-key={id}
      style={{ transform: translateOnlyTransform, transition }}
      className={`tower-main-tab-shell min-w-[4.5rem] max-w-[14rem] flex-[1_1_0] overflow-hidden ${className} ${isDragging ? 'opacity-60' : ''}`.trim()}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}

/**
 * Single chat tab. Subscribes narrowly to its own session's name + turn phase so
 * a streaming session only re-renders its own tab, not the whole bar.
 */
function ChatTabItem({
  sessionId,
  pinned,
  isActive,
  isMobile,
  onSelect,
  onClose,
  onPin,
  onContextMenu,
}: {
  sessionId: string;
  pinned: boolean;
  isActive: boolean;
  isMobile: boolean;
  onSelect: () => void;
  onClose: () => void;
  onPin: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const { t } = useTranslation('layout');
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId));
  const name = session?.name;
  const project = useProjectStore((s) => session?.projectId ? s.projects.find((item)=>item.id===session.projectId) || null : null);
  const turnState = useChatStore((s) => s.turnStateBySession[sessionId]);
  const phase = turnState?.phase ?? 'idle';
  const isSessionStreaming = useSessionStore((s) => s.streamingSessions.has(sessionId));
  const isUnreadAttention = session?.unreadAiResponse === true;
  const visibleChatSessionId = useSessionStore((s) => s.visibleChatSessionId);
  const queueCount = useChatStore((s) => (s.messageQueue[sessionId] ?? []).length);
  const markTurnRead = useChatStore((s) => s.markTurnRead);
  const activity = deriveSessionRowActivity({
    isStreaming: isSessionStreaming,
    phase,
    queueCount,
    summary: turnState?.activeToolSummary || turnState?.activeToolName,
  });
  const rowState = deriveSessionRowState(activity, isUnreadAttention);
  const showLeadingStatus = rowState.indicator.kind !== 'none' && rowState.indicator.kind !== 'queued';

  useEffect(() => {
    if (!isActive || visibleChatSessionId !== sessionId || !isUnreadAttention) return;
    if (document.visibilityState !== 'visible' || (typeof document.hasFocus === 'function' && !document.hasFocus())) return;
    markTurnRead(sessionId);
  }, [isActive, isUnreadAttention, markTurnRead, sessionId, visibleChatSessionId]);

  const stateClassName = isActive
    ? 'z-20 bg-surface-800 text-gray-100'
    : rowState.indicator.kind === 'awaiting_user'
      ? 'tone-warning z-0 tone-bg-soft tone-text hover:bg-[var(--tone-bg)]'
      : rowState.indicator.kind === 'running'
        ? 'z-0 bg-surface-900/35 text-gray-500 hover:text-gray-300 hover:bg-surface-900/65'
        : rowState.indicator.kind === 'done'
          ? 'z-0 bg-surface-900/60 text-gray-200 hover:text-gray-100 hover:bg-surface-900/85'
          : 'z-0 bg-surface-900/35 text-gray-500 hover:text-gray-300 hover:bg-surface-900/65';

  return (
    <MainTab
      active={isActive}
      isMobile={isMobile}
      height="chat"
      title={name ?? t('chatTabFallback')}
      dataRunState={rowState.indicator.kind}
      className={stateClassName}
      onSelect={() => {
        markTurnRead(sessionId);
        onSelect();
      }}
      onClose={onClose}
      onPin={onPin}
      onContextMenu={onContextMenu}
    >
      {project ? <AgentIdentityAvatar project={project} className={`tower-main-tab-avatar ${isMobile?'h-7 w-7':'h-5 w-5'} shrink-0 rounded-md`} fallbackClassName={`tower-main-tab-avatar ${isMobile?'h-7 w-7':'h-5 w-5'} shrink-0 rounded-md`}/> : !showLeadingStatus && <span aria-hidden="true" className="tower-main-tab-leading inline-block h-1 w-1 shrink-0 rounded-full bg-current opacity-60" />}
      {rowState.indicator.kind === 'awaiting_user' && <AwaitingUserMark active={isActive} />}
      {rowState.indicator.kind === 'running' && (
        <RunIndicator
          size={isActive ? 'xs' : 'sm'}
          label={t('sessionWorking')}
          className="tone-warning tone-text shrink-0"
        />
      )}
      {!isActive && rowState.indicator.kind === 'done' && (
        <span
          className="tone-success tone-text inline-flex h-4 w-3 shrink-0 items-center justify-center text-[14px] font-bold leading-none opacity-90"
          aria-label={t('completed')}
          title={t('completedUntilOpened')}
        >
          ✓
        </span>
      )}
      <span className={`tower-main-tab-title min-w-0 flex-1 overflow-hidden whitespace-nowrap ${isActive ? 'font-semibold text-gray-100' : 'font-medium'}`}>{name ?? t('chatTabFallback')}</span>
      <div className="tower-main-tab-actions flex shrink-0 items-center">
        <MainTabPinButton pinned={pinned} isMobile={isMobile} label={pinned ? t('unpinTab') : t('pinTab')} onToggle={onPin} />
        <MainTabCloseButton isMobile={isMobile} label={t('closeChatTab')} onClose={onClose} />
      </div>
    </MainTab>
  );
}

export function FileTabChip({
  tab,
  isActive,
  isMobile,
  onSelect,
  onClose,
  onPin,
  onContextMenu,
  className,
}: {
  tab: { id: string; path: string; name?: string; pinned: boolean; modified: boolean };
  isActive: boolean;
  isMobile: boolean;
  onSelect?: () => void;
  onClose: () => void;
  onPin: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  className?: string;
}) {
  const { t } = useTranslation('layout');
  return (
    <MainTab
      active={isActive}
      isMobile={isMobile}
      title={t('fileTabHint', { path: tab.path })}
      className={`${isActive ? 'z-10 bg-surface-800 text-gray-100' : 'z-0 bg-surface-900/35 text-gray-500 hover:text-gray-300 hover:bg-surface-900/65'} ${className ?? ''}`}
      onSelect={onSelect}
      onClose={onClose}
      onPin={onPin}
      onContextMenu={onContextMenu}
    >
      <span aria-hidden="true" className="tower-main-tab-leading shrink-0">{getFileIcon(tab.path)}</span>
      <span className={`tower-main-tab-title min-w-0 flex-1 overflow-hidden whitespace-nowrap font-normal ${tab.modified ? 'tone-warning tone-text' : ''}`}>
        {tab.name || basename(tab.path)}{tab.modified ? ' •' : ''}
      </span>
      <div className="tower-main-tab-actions flex shrink-0 items-center">
        <MainTabPinButton pinned={tab.pinned} isMobile={isMobile} label={tab.pinned ? t('unpinTab') : t('pinTab')} onToggle={onPin} />
        <MainTabCloseButton isMobile={isMobile} label={t('closeTab')} onClose={onClose} />
      </div>
    </MainTab>
  );
}

function SplitButton({
  disabled,
  active,
  onClick,
}: {
  disabled: boolean;
  active: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation('layout');
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`grid h-6 w-6 place-items-center rounded-md border transition-colors ${
        disabled
          ? 'cursor-not-allowed border-surface-700/50 bg-surface-900/55 text-gray-500 opacity-60'
          : active
            ? 'border-primary-500/60 bg-primary-500/15 text-primary-300 hover:bg-primary-500/20'
            : 'border-surface-700/70 bg-surface-900/75 text-gray-400 hover:bg-surface-800 hover:text-gray-100'
      }`}
      title={disabled ? t('selectFileTabForViewer') : t('viewCurrentFileInViewer')}
      aria-label={t('viewInViewer')}
    >
      <span className="relative block h-3.5 w-3.5 rounded-[3px] border border-current opacity-90">
        <span className="absolute inset-y-0 right-0 w-[45%] border-l border-current bg-current/20" />
      </span>
    </button>
  );
}

function ReloadFileButton({ disabled, modified, onClick }: { disabled: boolean; modified: boolean; onClick: () => void }) {
  const { t } = useTranslation('layout');
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`grid h-6 w-6 place-items-center rounded-md border transition-colors ${
        disabled
          ? 'cursor-not-allowed border-surface-700/50 bg-surface-900/55 text-gray-500 opacity-60'
          : modified
            ? 'tone-warning tone-border tone-bg-soft tone-text hover:bg-[var(--tone-bg)]'
            : 'border-surface-700/70 bg-surface-900/75 text-gray-400 hover:bg-surface-800 hover:text-gray-100'
      }`}
      title={disabled ? t('selectFileTabToRefresh') : modified ? t('refreshMayConflict') : t('reloadCurrentFileFromDisk')}
      aria-label={t('refreshCurrentFile')}
    >
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
    </button>
  );
}

function AiPanelButton({ disabled, active, title, ariaLabel, onClick }: { disabled: boolean; active: boolean; title?: string; ariaLabel?: string; onClick: () => void }) {
  const { t } = useTranslation('layout');
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`grid h-6 w-6 place-items-center rounded-md border transition-colors ${
        disabled
          ? 'cursor-not-allowed border-surface-700/50 bg-surface-900/55 text-gray-500 opacity-60'
          : active
            ? 'border-primary-500/60 bg-primary-500/15 text-primary-300 hover:bg-primary-500/20'
            : 'border-surface-700/70 bg-surface-900/75 text-gray-400 hover:bg-surface-800 hover:text-primary-300'
      }`}
      title={disabled ? t('noActiveSession') : (title || t('sessionAiPanel'))}
      aria-label={ariaLabel || t('sessionAiPanel')}
    >
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
      </svg>
    </button>
  );
}

export function FileTabBar({ onSelectChatSession, onRenameSession, onReloadFile }: FileTabBarProps) {
  const { t } = useTranslation('layout');
  const prompt = usePrompt();
  const tabs = useFileStore((s) => s.tabs);
  const chatTabs = useFileStore((s) => s.chatTabs);
  const systemTabs = useFileStore((s) => s.systemTabs);
  const activeSystemTabId = useFileStore((s) => s.activeSystemTabId);
  const activeTabId = useFileStore((s) => s.activeTabId);
  const setActiveTab = useFileStore((s) => s.setActiveTab);
  const closeTab = useFileStore((s) => s.closeTab);
  const closeOtherTabs = useFileStore((s) => s.closeOtherTabs);
  const closeAllTabs = useFileStore((s) => s.closeAllTabs);
  const pinTab = useFileStore((s) => s.pinTab);
  const moveTabToPane = useFileStore((s) => s.moveTabToPane);
  const splitTabId = useFileStore((s) => s.splitTabId);
  const splitOrientation = useFileStore((s) => s.splitOrientation);
  const tabOrder = useFileStore((s) => s.tabOrder);
  const reorderTabOrder = useFileStore((s) => s.reorderTabOrder);
  const closeChatTab = useFileStore((s) => s.closeChatTab);
  const pinChatTab = useFileStore((s) => s.pinChatTab);
  const closeSystemTab = useFileStore((s) => s.closeSystemTab);
  const pinSystemTab = useFileStore((s) => s.pinSystemTab);
  const activateSystemTab = useFileStore((s) => s.activateSystemTab);

  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeView = useSessionStore((s) => s.activeView);
  const isMobile = useSessionStore((s) => s.isMobile);
  const sessions = useSessionStore((s) => s.sessions);
  const aiPanelOpen = useAiPanelStore((s) => s.open);
  const aiPanelContextType = useAiPanelStore((s) => s.contextType);
  const projects = useProjectStore((s) => s.projects);

  const splitTargetTabId = activeTabId && activeTabId !== splitTabId ? activeTabId : null;
  const activeFileTab = activeTabId ? tabs.find((tab) => tab.id === activeTabId) : null;
  // Normalize foreground tab priority for rendering. Store actions normally keep
  // these mutually exclusive, but persisted/restored state or older flows can
  // briefly leave more than one active id. Rendering from one explicit kind
  // prevents a file tab and chat tab from both looking selected.
  const activeMainKind: 'file' | 'system' | 'chat' = activeSystemTabId && systemTabs.some((tab) => tab.id === activeSystemTabId)
    ? 'system'
    : activeFileTab
      ? 'file'
      : 'chat';
  const showSessionAiPanel = aiPanelOpen && aiPanelContextType === 'session';

  useEffect(() => {
    useSessionStore.getState().setVisibleChatSessionId(
      activeMainKind === 'chat' && activeView === 'chat' ? activeSessionId : null,
    );
    return () => useSessionStore.getState().setVisibleChatSessionId(null);
  }, [activeMainKind, activeSessionId, activeView]);
  const lastActiveChatSessionIdRef = useRef<string | null>(activeSessionId);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: isMobile ? { delay: 180, tolerance: 8 } : { distance: 6 } }));
  const orderedTabs = useMemo(() => {
    const chatById = new Map(chatTabs.map((t) => [t.id, t]));
    const fileById = new Map(tabs.map((t) => [t.id, t]));
    const systemById = new Map(systemTabs.map((t) => [t.id, t]));
    const seen = new Set<string>();
    const result: Array<{ key: string; kind: 'chat'; tab: typeof chatTabs[number] } | { key: string; kind: 'file'; tab: typeof tabs[number] } | { key: string; kind: 'system'; tab: typeof systemTabs[number] }> = [];
    for (const item of tabOrder) {
      const key = `${item.kind}:${item.id}`;
      if (seen.has(key)) continue;
      if (item.kind === 'chat') {
        const tab = chatById.get(item.id);
        if (tab) { result.push({ key, kind: 'chat', tab }); seen.add(key); }
      } else if (item.kind === 'file') {
        const tab = fileById.get(item.id);
        if (tab) { result.push({ key, kind: 'file', tab }); seen.add(key); }
      } else {
        const tab = systemById.get(item.id);
        if (tab) { result.push({ key, kind: 'system', tab }); seen.add(key); }
      }
    }
    for (const tab of chatTabs) { const key = `chat:${tab.id}`; if (!seen.has(key)) result.push({ key, kind: 'chat', tab }); }
    for (const tab of tabs) { const key = `file:${tab.id}`; if (!seen.has(key)) result.push({ key, kind: 'file', tab }); }
    for (const tab of systemTabs) { const key = `system:${tab.id}`; if (!seen.has(key)) result.push({ key, kind: 'system', tab }); }
    return result;
  }, [chatTabs, tabs, systemTabs, tabOrder]);
  const visibleOrderedTabs = useMemo(
    () => orderedTabs.filter((item) => item.kind !== 'file' || (item.tab.pane !== 'extra' && item.tab.id !== splitTabId)),
    [orderedTabs, splitTabId],
  );

  useEffect(() => {
    if (activeTabId === null && !activeSystemTabId && activeSessionId) {
      lastActiveChatSessionIdRef.current = activeSessionId;
    }
  }, [activeSessionId, activeSystemTabId, activeTabId]);

  useEffect(() => {
    // Archived sessions drop out of the active `sessions` list. Chat tabs are
    // lightweight bookmarks, so remove tabs whose backing session is no longer
    // visible instead of leaving stale tab chrome behind.
    if (sessions.length === 0 || chatTabs.length === 0) return;
    const visibleSessionIds = new Set(sessions.map((s) => s.id));
    for (const tab of chatTabs) {
      if (!visibleSessionIds.has(tab.sessionId)) closeChatTab(tab.id);
    }
  }, [chatTabs, closeChatTab, sessions]);

  const [tabbarOverflow, setTabbarOverflow] = useState({ left: false, right: false });
  const tabbarRef = useRef<HTMLDivElement | null>(null);
  const revealTabInStrip = useCallback((key: string, align: ScrollLogicalPosition = 'center') => {
    window.requestAnimationFrame(() => {
      const tab = tabbarRef.current?.querySelector<HTMLElement>(`[data-main-tab-key="${CSS.escape(key)}"]`);
      tab?.scrollIntoView({ behavior: 'smooth', inline: align, block: 'nearest' });
    });
  }, []);
  const updateTabbarOverflow = useCallback(() => {
    const el = tabbarRef.current;
    if (!el) return;
    const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
    setTabbarOverflow({
      left: el.scrollLeft > 2,
      right: el.scrollLeft < maxScrollLeft - 2,
    });
  }, []);
  const scrollTabbarBy = useCallback((direction: -1 | 1) => {
    tabbarRef.current?.scrollBy({ left: direction * 220, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const el = tabbarRef.current;
    if (!el) return;
    updateTabbarOverflow();
    el.addEventListener('scroll', updateTabbarOverflow, { passive: true });
    const resizeObserver = new ResizeObserver(updateTabbarOverflow);
    resizeObserver.observe(el);
    return () => {
      el.removeEventListener('scroll', updateTabbarOverflow);
      resizeObserver.disconnect();
    };
  }, [updateTabbarOverflow, visibleOrderedTabs.length]);

  useEffect(() => {
    updateTabbarOverflow();
  }, [updateTabbarOverflow, visibleOrderedTabs.length, activeTabId, activeSystemTabId]);

  useEffect(() => {
    if (activeSystemTabId) {
      revealTabInStrip(`system:${activeSystemTabId}`);
      return;
    }
    if (activeTabId) {
      revealTabInStrip(`file:${activeTabId}`);
      return;
    }
    const activeChatTab = chatTabs.find((tab) => tab.sessionId === activeSessionId);
    if (activeChatTab) revealTabInStrip(`chat:${activeChatTab.id}`);
  }, [activeSessionId, activeSystemTabId, activeTabId, chatTabs, revealTabInStrip]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    reorderTabOrder(String(active.id), String(over.id));
  }, [reorderTabOrder]);

  const revealInSidebar = useCallback(async (target: { kind: 'chat'; sessionId: string } | { kind: 'file'; path: string }) => {
    const sessionStore = useSessionStore.getState();
    const fileStore = useFileStore.getState();
    const cssEscape = (value: string) => (window.CSS?.escape ? window.CSS.escape(value) : value.replace(/(["'\\\]\[])/g, '\\$1'));
    let selector = '';

    if (target.kind === 'chat') {
      sessionStore.setSidebarTab('sessions');
      const session = sessions.find((s) => s.id === target.sessionId);
      window.dispatchEvent(new CustomEvent('tower-reveal-session-in-sidebar', {
        detail: { sessionId: target.sessionId },
      }));
      const projectStore = useProjectStore.getState();
      if (session?.projectId && projectStore.isProjectCollapsed(session.projectId)) {
        projectStore.toggleProjectCollapsed(session.projectId);
      }
      if (session?.projectId && session.label && projectStore.collapsedLabels.has(`${session.projectId}::${session.label}`)) {
        projectStore.toggleLabelCollapsed(session.projectId, session.label);
      }
      selector = `[data-sidebar-session-id="${cssEscape(target.sessionId)}"]`;
    } else if (target.kind === 'file') {
      const project = findOwningProjectForPath(useProjectStore.getState().projects, target.path);
      if (!project?.rootPath) {
        toastQuiet(t('fileOwnerNotFound'));
        return;
      }
      sessionStore.setSidebarTab('files');
      useSettingsStore.getState().setCapabilityProjectId(project.id);
      if (!fileStore.expandedProjects.has(project.id)) {
        fileStore.toggleProjectExpanded(project.id);
      }
      for (const ancestorPath of getSidebarAncestorPaths(target.path, project.rootPath)) {
        fileStore.addExpandedPath(ancestorPath);
      }
      fileStore.bumpRefreshTrigger();
      selector = `[data-sidebar-file-path="${cssEscape(normalizeSidebarFilePath(target.path))}"]`;
    }

    sessionStore.setSidebarOpen(true);

    let attempts = 0;
    const clickedExpanders = new Set<string>();
    const clickOnce = (selector: string) => {
      if (clickedExpanders.has(selector)) return;
      const button = document.querySelector<HTMLElement>(selector);
      if (!button) return;
      clickedExpanders.add(selector);
      button.click();
    };
    const tryReveal = () => {
      attempts += 1;
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) {
        if (target.kind === 'chat') {
          const session = sessions.find((s) => s.id === target.sessionId);
          const projectId = session?.projectId || '__ungrouped__';
          const labelKey = session?.projectId && session.label ? `${session.projectId}::${session.label}` : '';
          clickOnce(`[data-sidebar-session-showall-project="${cssEscape(projectId)}"]`);
          if (labelKey) clickOnce(`[data-sidebar-session-showall-label="${cssEscape(labelKey)}"]`);
        }
        if (target.kind === 'file' && attempts % 10 === 0) fileStore.bumpRefreshTrigger();
        if (attempts < 60) window.setTimeout(tryReveal, 100);
        else toastQuiet(t('sidebarTargetNotFound'));
        return;
      }

      const highlightClass = target.kind === 'file' ? 'tower-sidebar-reveal-highlight-file' : 'tower-sidebar-reveal-highlight';
      const ancestorElements: HTMLElement[] = [];
      if (target.kind === 'file') {
        const project = findOwningProjectForPath(projects, target.path);
        for (const ancestorPath of getSidebarAncestorPaths(target.path, project?.rootPath)) {
          const ancestor = document.querySelector<HTMLElement>(`[data-sidebar-file-path="${cssEscape(ancestorPath)}"]`);
          if (ancestor) {
            ancestor.classList.add('tower-sidebar-reveal-ancestor');
            ancestorElements.push(ancestor);
          }
        }
        toastQuiet(t('sidebarLocation', { location: formatSidebarLocation(target.path, project) }));
      }

      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add(highlightClass);
      window.setTimeout(() => {
        el.classList.remove(highlightClass);
        for (const ancestor of ancestorElements) ancestor.classList.remove('tower-sidebar-reveal-ancestor');
      }, 2200);
    };
    window.setTimeout(tryReveal, 80);
  }, [projects, sessions]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string; path?: string; sessionId?: string; roomId?: string }>).detail;
      if (detail?.kind === 'file' && detail.path) void revealInSidebar({ kind: 'file', path: detail.path });
      else if (detail?.kind === 'chat' && detail.sessionId) void revealInSidebar({ kind: 'chat', sessionId: detail.sessionId });
    };
    window.addEventListener('tower-reveal-tab-target', handler as EventListener);
    return () => window.removeEventListener('tower-reveal-tab-target', handler as EventListener);
  }, [revealInSidebar]);

  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const [sessionInfoId, setSessionInfoId] = useState<string | null>(null);
  const [shareFilePath, setShareFilePath] = useState<string | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);

  // Click outside or Esc → close ctx menu
  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

  // ── Chat tab handlers ──
  const handleChatClose = useCallback((id: string) => {
    const beforeFileState = useFileStore.getState();
    const closingTab = beforeFileState.chatTabs.find((tab) => tab.id === id);
    const wasActiveChat = !!closingTab
      && closingTab.sessionId === useSessionStore.getState().activeSessionId
      && beforeFileState.activeTabId === null
      && !beforeFileState.activeSystemTabId;

    const nextSessionId = closeChatTab(id);
    if (nextSessionId) {
      onSelectChatSession(nextSessionId);
      return;
    }

    // If the user closed the last visible chat tab and there is no file/room/system
    // fallback, leave chat mode as an explicit empty state. Otherwise the single
    // ChatPanel keeps rendering the previously active session even though all tabs
    // are gone, which makes closed conversations look "stuck" on screen.
    const afterFileState = useFileStore.getState();
    if (
      wasActiveChat
      && afterFileState.chatTabs.length === 0
      && afterFileState.activeTabId === null
      && !afterFileState.activeSystemTabId
    ) {
      const chatStore = useChatStore.getState();
      useSessionStore.getState().setActiveSessionId(null);
      chatStore.setSessionId(null);
      chatStore.setStreaming(false);
      chatStore.clearAttachments();
      chatStore.setSessionLoading(false);
      chatStore.clearMessages();
    }
  }, [closeChatTab, onSelectChatSession]);

  const handleToggleAiPanel = useCallback(() => {
    if (!activeSessionId) return;
    const fileAnchor = activeFileTab
      ? { path: activeFileTab.path, title: basename(activeFileTab.path), language: activeFileTab.language }
      : null;
    const store = useAiPanelStore.getState();
    if (store.open && store.contextType === 'session') {
      const sameSession = store.contextId === activeSessionId;
      const sameFile = (store.fileAnchor?.path || null) === (fileAnchor?.path || null);
      if (sameSession && sameFile) {
        store.setOpen(false);
        return;
      }
    }
    store.setContext('session', activeSessionId, fileAnchor);
    store.setActiveThreadId(null);
    store.setMessages([]);
    store.setPendingQuestion(null);
    store.setOpen(true);
  }, [activeFileTab, activeSessionId]);

  // ── File tab handlers ──
  const handleFileClose = useCallback((tabId: string) => {
    const closingActiveMainFile = activeTabId === tabId && tabId !== splitTabId;
    const hasNextMainFile = tabs.some((tab) => tab.id !== tabId && tab.id !== splitTabId);
    const returnSessionId = closingActiveMainFile && !hasNextMainFile
      ? (lastActiveChatSessionIdRef.current || activeSessionId)
      : null;

    closeTab(tabId);

    // When the last active main file tab is closed, restore the chat tab the
    // user was on immediately before entering file mode. Relying on the global
    // activeSessionId alone is brittle because URL sync/background tab events can
    // move it while a file tab is foregrounded.
    if (returnSessionId) onSelectChatSession(returnSessionId);
  }, [activeSessionId, activeTabId, closeTab, onSelectChatSession, splitTabId, tabs]);

  const onTabAuxClick = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      if (e.button === 1) {
        e.preventDefault();
        handleFileClose(tabId);
      }
    },
    [handleFileClose]
  );

  const onTabContextMenu = useCallback(
    (e: React.MouseEvent, kind: CtxMenuState['kind'], id: string, pinned: boolean) => {
      e.preventDefault();
      setCtxMenu({ x: e.clientX, y: e.clientY, kind, id, pinned });
    },
    []
  );

  return (
    <>
      <div className="tower-main-tabbar-shell flex shrink-0 items-end bg-surface-950/45" data-tour-id="file-tabbar">
        <div className="relative min-w-0 flex-1">
          <div
            ref={tabbarRef}
          className="tower-main-tabbar flex items-end gap-0.5 overflow-x-auto scrollbar-none px-1.5 pt-1.5 pb-0 text-sm leading-none select-none"
          role="tablist"
          aria-label={t('mainTabBar')}
        >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={visibleOrderedTabs.map((t) => t.key)} strategy={horizontalListSortingStrategy}>
            {visibleOrderedTabs.map((item) => {
              if (item.kind === 'chat') {
                const c = item.tab;
                return (
                  <SortableTabShell key={item.key} id={item.key}>
                    <ChatTabItem
                      sessionId={c.sessionId}
                      pinned={c.pinned}
                      isActive={activeMainKind === 'chat' && c.sessionId === activeSessionId}
                      isMobile={isMobile}
                      onSelect={() => {
                        onSelectChatSession(c.sessionId);
                        revealTabInStrip(item.key);
                      }}
                      onClose={() => handleChatClose(c.id)}
                      onPin={() => {
                        pinChatTab(c.id);
                        toastQuiet(c.pinned ? t('tabUnpinned') : t('tabPinned'));
                      }}
                      onContextMenu={(e) => onTabContextMenu(e, 'chat', c.id, c.pinned)}
                    />
                  </SortableTabShell>
                );
              }
              if (item.kind === 'system') {
                const s = item.tab;
                const projectHome = s.kind === 'projectFiles' && s.refId ? projects.find((project) => project.id === s.refId) : null;
                const systemTabTitle = projectHome
                  ? projectHome.agent?.displayName || projectHome.name
                  : s.kind === 'projectFiles' && s.title === '프로젝트 홈'
                    ? t('workspaceFiles')
                    : s.title;
                const systemTabAccessibleTitle = projectHome ? `${systemTabTitle} · ${t('teammateHome')}` : systemTabTitle;
                const isActive = activeMainKind === 'system' && activeSystemTabId === s.id;
                return (
                  <SortableTabShell key={item.key} id={item.key}>
                    <MainTab
                      active={isActive}
                      isMobile={isMobile}
                      title={systemTabAccessibleTitle}
                      className={isActive ? 'z-10 bg-surface-800 text-gray-100' : 'z-0 bg-surface-900/35 text-gray-500 hover:text-gray-300 hover:bg-surface-900/65'}
                      onSelect={() => {
                        activateSystemTab(s.id);
                        revealTabInStrip(item.key);
                      }}
                      onClose={() => closeSystemTab(s.id)}
                      onPin={() => {
                        pinSystemTab(s.id);
                        toastQuiet(s.pinned ? t('tabUnpinned') : t('tabPinned'));
                      }}
                      onContextMenu={(event) => onTabContextMenu(event, 'system', s.id, s.pinned)}
                    >
                      {projectHome ? (
                        <AgentIdentityAvatar project={projectHome} className={`tower-main-tab-avatar ${isMobile ? 'h-7 w-7' : 'h-5 w-5'} shrink-0 rounded-md`} fallbackClassName={`tower-main-tab-avatar ${isMobile ? 'h-7 w-7' : 'h-5 w-5'} shrink-0 rounded-md`} />
                      ) : (
                        <span aria-hidden="true" className="tower-main-tab-leading shrink-0">{s.icon}</span>
                      )}
                      <span className="tower-main-tab-title min-w-0 flex-1 overflow-hidden whitespace-nowrap font-normal">{systemTabTitle}</span>
                      {projectHome && <span className="tower-main-tab-kind tone-accent tone-pill shrink-0 px-1.5 py-0.5 text-[9px] font-bold leading-none not-italic">{t('teammateHome')}</span>}
                      <div className="tower-main-tab-actions flex shrink-0 items-center">
                        <MainTabPinButton pinned={s.pinned} isMobile={isMobile} label={s.pinned ? t('unpinTab') : t('pinTab')} onToggle={() => {
                          pinSystemTab(s.id);
                          toastQuiet(s.pinned ? t('tabUnpinned') : t('tabPinned'));
                        }} />
                        <MainTabCloseButton isMobile={isMobile} alwaysVisible={s.kind === 'projectFiles'} label={t('closeSystemTab')} onClose={() => closeSystemTab(s.id)} />
                      </div>
                    </MainTab>
                  </SortableTabShell>
                );
              }
              const fileTab = item.tab;
              const isActive = activeMainKind === 'file' && fileTab.id === activeTabId;
              return (
                <SortableTabShell key={item.key} id={item.key}>
                  <FileTabChip
                    tab={fileTab}
                    isActive={isActive}
                    isMobile={isMobile}
                    onSelect={() => {
                      setActiveTab(fileTab.id);
                      revealTabInStrip(item.key);
                    }}
                    onClose={() => handleFileClose(fileTab.id)}
                    onPin={() => {
                      pinTab(fileTab.id);
                      toastQuiet(fileTab.pinned ? t('tabUnpinned') : t('tabPinned'));
                    }}
                    onContextMenu={(e) => onTabContextMenu(e, 'file', fileTab.id, fileTab.pinned)}
                  />
                </SortableTabShell>
              );
            })}
          </SortableContext>
        </DndContext>

          </div>
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-surface-950 via-surface-950/75 to-transparent transition-opacity ${tabbarOverflow.left ? 'opacity-100' : 'opacity-0'}`}
          />
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-surface-950 via-surface-950/75 to-transparent transition-opacity ${tabbarOverflow.right ? 'opacity-100' : 'opacity-0'}`}
          />
          {tabbarOverflow.left && (
            <button
              type="button"
              onClick={() => scrollTabbarBy(-1)}
              aria-label={t('moreTabsLeft')}
              className="absolute left-1 top-1/2 z-20 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full border border-surface-700/70 bg-surface-900/85 text-[15px] text-surface-300 shadow-sm transition hover:border-surface-500 hover:bg-surface-800 hover:text-surface-50"
            >
              ‹
            </button>
          )}
          {tabbarOverflow.right && (
            <button
              type="button"
              onClick={() => scrollTabbarBy(1)}
              aria-label={t('moreTabsRight')}
              className="absolute right-1 top-1/2 z-20 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full border border-surface-700/70 bg-surface-900/85 text-[15px] text-surface-300 shadow-sm transition hover:border-surface-500 hover:bg-surface-800 hover:text-surface-50"
            >
              ›
            </button>
          )}
        </div>
        <div className="flex h-7 shrink-0 items-center gap-1 border-l border-surface-800/70 bg-surface-950/80 pl-2 pr-1">
          {activeFileTab && (
            <ReloadFileButton
              disabled={false}
              modified={activeFileTab.modified}
              onClick={() => onReloadFile(activeFileTab.path)}
            />
          )}
          {splitTargetTabId && (
            <SplitButton
              disabled={false}
              active={!!splitTabId}
              onClick={() => moveTabToPane(splitTargetTabId, 'extra', { orientation: 'right' })}
            />
          )}
          <AiPanelButton
            disabled={!activeSessionId}
            active={showSessionAiPanel}
            title={activeFileTab ? t('askAiAboutFileNamed', { name: basename(activeFileTab.path) }) : t('sessionAiPanel')}
            ariaLabel={activeFileTab ? t('askAiAboutCurrentFile') : t('sessionAiPanel')}
            onClick={handleToggleAiPanel}
          />
        </div>
      </div>

      {/* ── 우클릭 컨텍스트 메뉴 ──
          Portal to document.body. 채팅 컨테이너의 backdrop-blur-3xl 이
          containing block 을 만들어 fixed 좌표가 viewport 가 아닌 그 컨테이너
          기준이 되는 버그(메뉴가 사이드바 폭만큼 어긋남) 회피. +2px 오프셋은
          커서가 메뉴 모서리에 닿지 않게 하는 시각적 여백. */}
      {sessionInfoId && createPortal(
        <SessionInfoDialog
          sessionId={sessionInfoId}
          sessions={sessions}
          projects={projects}
          onClose={() => setSessionInfoId(null)}
        />,
        document.body,
      )}

      {shareFilePath && createPortal(
        <ShareModal filePath={shareFilePath} onClose={() => setShareFilePath(null)} />,
        document.body,
      )}

      {ctxMenu && createPortal(
        <>
          {isMobile && <div className="fixed inset-0 z-40 bg-black/25" onClick={() => setCtxMenu(null)} aria-hidden="true" />}
          <div
            ref={ctxMenuRef}
            className={isMobile
              ? "fixed inset-x-2 bottom-[calc(env(safe-area-inset-bottom,0px)+0.5rem)] z-50 max-h-[82vh] overflow-y-auto overscroll-contain bg-surface-900 border border-surface-700 rounded-2xl shadow-2xl py-2 text-base text-gray-200"
              : "fixed z-50 min-w-[180px] py-1 bg-surface-900 border border-surface-700 rounded-md shadow-xl text-base text-gray-200"
            }
            style={isMobile ? undefined : { left: ctxMenu.x + 2, top: ctxMenu.y + 2 }}
            role="menu"
            onClick={(e) => e.stopPropagation()}
          >
          {ctxMenu.kind === 'chat' ? (
            <>
              <button
                onClick={() => {
                  const tab = chatTabs.find((c) => c.id === ctxMenu.id);
                  if (tab) setSessionInfoId(tab.sessionId);
                  setCtxMenu(null);
                }}
                className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800"
              >
                {t('sessionInfo')}
              </button>
              <button
                onClick={() => {
                  const tab = chatTabs.find((c) => c.id === ctxMenu.id);
                  if (tab) revealInSidebar({ kind: 'chat', sessionId: tab.sessionId });
                  setCtxMenu(null);
                }}
                className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800"
              >
                {t('showInSidebar')}
              </button>
              <button
                onClick={async () => {
                  const tab = chatTabs.find((c) => c.id === ctxMenu.id);
                  const session = tab ? sessions.find((s) => s.id === tab.sessionId) : undefined;
                  setCtxMenu(null);
                  if (!tab) return;
                  const next = await prompt({
                    title: t('renameSession'),
                    message: t('enterNewSessionName'),
                    initialValue: session?.name ?? '',
                    confirmLabel: t('change'),
                  });
                  const trimmed = next?.trim();
                  if (trimmed && trimmed !== session?.name) {
                    onRenameSession(tab.sessionId, trimmed);
                  }
                }}
                className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800"
              >
                {t('rename')}
              </button>
              <div className="my-1 h-px bg-surface-800" />
              <button
                onClick={() => { handleChatClose(ctxMenu.id); setCtxMenu(null); }}
                className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800"
              >
                {t('closeTab')}
              </button>
              <div className="my-1 h-px bg-surface-800" />
              <button
                onClick={() => {
                  pinChatTab(ctxMenu.id);
                  toastQuiet(ctxMenu.pinned ? t('tabUnpinned') : t('tabPinned'));
                  setCtxMenu(null);
                }}
                className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800 flex items-center justify-between gap-3"
              >
                <span>{ctxMenu.pinned ? t('unpinTab') : t('pinTab')}</span>
                <span className="text-[12px] text-gray-500">{t('doubleClick')}</span>
              </button>
            </>
          ) : ctxMenu.kind === 'system' ? (
            <>
              <button
                onClick={() => { closeSystemTab(ctxMenu.id); setCtxMenu(null); }}
                className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800"
              >
                {t('closeTab')}
              </button>
              <div className="my-1 h-px bg-surface-800" />
              <button
                onClick={() => {
                  pinSystemTab(ctxMenu.id);
                  toastQuiet(ctxMenu.pinned ? t('tabUnpinned') : t('tabPinned'));
                  setCtxMenu(null);
                }}
                className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800 flex items-center justify-between gap-3"
              >
                <span>{ctxMenu.pinned ? t('unpinTab') : t('pinTab')}</span>
                <span className="text-[12px] text-gray-500">{t('doubleClick')}</span>
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  const tab = tabs.find((t) => t.id === ctxMenu.id);
                  if (tab) revealInSidebar({ kind: 'file', path: tab.path });
                  setCtxMenu(null);
                }}
                className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800"
              >
                {t('goToFolder')}
              </button>
              <button
                onClick={() => {
                  const tab = tabs.find((t) => t.id === ctxMenu.id);
                  setCtxMenu(null);
                  if (!tab) return;
                  const token = localStorage.getItem('token');
                  const url = towerHttpUrl(`/api/files/serve?path=${encodeURIComponent(tab.path)}&download=1${token ? `&token=${encodeURIComponent(token)}` : ''}`);
                  window.open(url, '_blank');
                }}
                className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800"
              >
                {t('download')}
              </button>
              <button
                onClick={() => {
                  const tab = tabs.find((t) => t.id === ctxMenu.id);
                  setCtxMenu(null);
                  if (tab) setShareFilePath(tab.path);
                }}
                className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800"
              >
                {t('share')}
              </button>
              <div className="my-1 h-px bg-surface-800" />
              {(tabs.find((t) => t.id === ctxMenu.id)?.pane === 'extra' || ctxMenu.id === splitTabId) ? (
                <button
                  onClick={() => {
                    moveTabToPane(ctxMenu.id, 'main');
                    setCtxMenu(null);
                  }}
                  className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800 flex items-center justify-between gap-3"
                >
                  <span>{t('moveToMainTab')}</span>
                  <span className="text-[12px] text-gray-500">↙</span>
                </button>
              ) : (
                <>
                  <button
                    onClick={() => {
                      moveTabToPane(ctxMenu.id, 'extra', { orientation: 'right' });
                      setCtxMenu(null);
                    }}
                    className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800 flex items-center justify-between gap-3"
                  >
                    <span>{t('viewInViewer')}</span>
                    <span className="text-[12px] text-gray-500">↗</span>
                  </button>
                </>
              )}
              <div className="my-1 h-px bg-surface-800" />
              <button
                onClick={() => { handleFileClose(ctxMenu.id); setCtxMenu(null); }}
                className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800"
              >
                {t('closeTab')}
              </button>
              <button
                onClick={() => { closeOtherTabs(ctxMenu.id); setCtxMenu(null); }}
                className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800"
              >
                {t('closeOtherTabs')}
              </button>
              <button
                onClick={() => { closeAllTabs(); setCtxMenu(null); }}
                className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800"
              >
                {t('closeAllTabs')}
              </button>
              <div className="my-1 h-px bg-surface-800" />
              <button
                onClick={() => {
                  pinTab(ctxMenu.id);
                  toastQuiet(ctxMenu.pinned ? t('tabUnpinned') : t('tabPinned'));
                  setCtxMenu(null);
                }}
                className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800 flex items-center justify-between gap-3"
              >
                <span>{ctxMenu.pinned ? t('unpinTab') : t('pinTab')}</span>
                <span className="text-[12px] text-gray-500">{t('doubleClick')}</span>
              </button>
            </>
          )}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

interface SessionInfoMetrics {
  contextInput: number;
  contextWindow: number;
}

function formatPathForDisplay(path?: string | null): string {
  return path ? path.replace(/^\/home\/[^/]+/, '~') : '—';
}

function formatContextUsage(metrics: SessionInfoMetrics | null, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (!metrics || metrics.contextInput <= 0 || metrics.contextWindow <= 0) return t('notAvailableYet');
  const pct = Math.min((metrics.contextInput / metrics.contextWindow) * 100, 100);
  return t('contextUsageValue', {
    used: fmtTokensShort(metrics.contextInput),
    window: fmtTokensShort(metrics.contextWindow),
    percent: pct < 1 ? '<1' : pct.toFixed(0),
  });
}

function SessionInfoDialog({ sessionId, sessions, projects, onClose }: {
  sessionId: string;
  sessions: ReturnType<typeof useSessionStore.getState>['sessions'];
  projects: ReturnType<typeof useProjectStore.getState>['projects'];
  onClose: () => void;
}) {
  const { t } = useTranslation('layout');
  const session = sessions.find((s) => s.id === sessionId);
  const project = session?.projectId ? projects.find((p) => p.id === session.projectId) : undefined;
  const sessionUrl = `${window.location.origin}/s/${session?.id ?? sessionId}`;
  const [metrics, setMetrics] = useState<SessionInfoMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const availableModels = useModelStore((s) => s.availableModels);
  const piModels = useModelStore((s) => s.piModels);
  const localModels = useModelStore((s) => s.localModels);
  const allModels = useMemo(
    () => [...availableModels, ...piModels, ...localModels],
    [availableModels, piModels, localModels],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    fetch(`/api/sessions/${sessionId}/messages?limit=80`, { headers })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (cancelled) return;
        const messages = Array.isArray(data?.messages) ? data.messages : [];
        const fallbackWindow = contextWindowForSession(session, allModels);
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]?.role !== 'assistant') continue;
          const input = contextInputFromUsageOrRow(messages[i]);
          const win = Number(messages[i]?.metadata?.usage?.context_window_size || fallbackWindow || 0);
          if (input > 0 && win > 0) {
            setMetrics({ contextInput: input, contextWindow: win });
            return;
          }
        }
        setMetrics(null);
      })
      .catch(() => { if (!cancelled) setMetrics(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, session?.updatedAt, session?.modelUsed, session?.engine, allModels]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45" onMouseDown={onClose}>
      <div
        className="w-[420px] max-w-[calc(100vw-32px)] rounded-xl border border-surface-700 bg-surface-950 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('sessionInfo')}
      >
        <div className="flex items-center justify-between border-b border-surface-800 px-4 py-3">
          <div>
            <div className="text-[15px] font-semibold text-surface-100">{t('sessionInfo')}</div>
            <div className="mt-0.5 max-w-[320px] truncate text-[13px] text-surface-500">{session?.name ?? t('unnamedSession')}</div>
          </div>
          <button className="rounded-md px-2 py-1 text-surface-500 hover:bg-surface-800 hover:text-surface-200" onClick={onClose} aria-label={t('common:close')}>×</button>
        </div>
        <div className="space-y-3 px-4 py-4 text-[14px]">
          <InfoRow label={t('workspace')} value={project?.name ?? (session?.projectId ? t('unknown') : t('none'))} />
          <InfoRow label={t('recentContextUsage')} value={loading ? t('common:loading') : formatContextUsage(metrics, t)} />
          <InfoRow label={t('workspacePath')} value={formatPathForDisplay(project?.rootPath ?? session?.cwd)} mono />
          <InfoRow label={t('model')} value={session?.modelUsed || session?.engine || t('unknown')} />
          <SessionLinkRow url={sessionUrl} />
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value, mono, subtle }: { label: string; value: string; mono?: boolean; subtle?: boolean }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3">
      <div className="text-surface-500">{label}</div>
      <div className={`min-w-0 truncate ${mono ? 'font-mono' : ''} ${subtle ? 'text-surface-500' : 'text-surface-200'}`} title={value}>{value}</div>
    </div>
  );
}

function SessionLinkRow({ url }: { url: string }) {
  const { t } = useTranslation('layout');
  const [copied, setCopied] = useState(false);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toastQuiet(t('linkCopyFailed'));
    }
  };

  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3">
      <div className="text-surface-500">{t('sessionLink')}</div>
      <button
        type="button"
        onClick={copyLink}
        className="min-w-0 truncate text-left font-mono text-[13px] text-surface-200 hover:text-surface-50"
        title={t('clickToCopyLink', { url })}
      >
        {copied ? t('copied') : url}
      </button>
    </div>
  );
}
