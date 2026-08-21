import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { useShallow } from 'zustand/react/shallow';
import { Toaster } from 'sonner';
import { useTranslation } from 'react-i18next';
import { Header } from './components/layout/Header';
import { Sidebar } from './components/layout/Sidebar';
import { ChatPanel } from './components/chat/ChatPanel';
import type { SendOptions } from './components/chat/InputBox';
import { ContextPanel } from './components/layout/ContextPanel';
import { FileTabBar, FileTabChip, SortableTabShell } from './components/layout/FileTabBar';
import { ShareModal } from './components/files/ShareModal';
import { AITeamQuickPanel } from './components/agents/AITeamQuickPanel';
import { LoginPage } from './components/auth/LoginPage';

function lazyNamed<T extends React.ComponentType<any>>(
  loader: () => Promise<Record<string, any>>,
  exportName: string,
): T {
  const Deferred = React.lazy(async () => {
    const module = await loader();
    return { default: module[exportName] as T };
  });
  return ((props: React.ComponentProps<T>) => (
    <React.Suspense fallback={null}>
      <Deferred {...props} />
    </React.Suspense>
  )) as T;
}

// Route/view chunks — fetched only when the corresponding surface is rendered.
const FilesWorkspace = lazyNamed<typeof import('./components/files/FilesWorkspace').FilesWorkspace>(() => import('./components/files/FilesWorkspace'), 'FilesWorkspace');
const ProjectHome = lazyNamed<typeof import('./components/files/ProjectHome').ProjectHome>(() => import('./components/files/ProjectHome'), 'ProjectHome');
const AITeamHome = lazyNamed<typeof import('./components/agents/AITeamHome').AITeamHome>(() => import('./components/agents/AITeamHome'), 'AITeamHome');
const SettingsPanel = lazyNamed<typeof import('./components/settings/SettingsPanel').SettingsPanel>(() => import('./components/settings/SettingsPanel'), 'SettingsPanel');
const AdminPanel = lazyNamed<typeof import('./components/admin/AdminPanel').AdminPanel>(() => import('./components/admin/AdminPanel'), 'AdminPanel');
const PersonalCredentialsPanel = lazyNamed<typeof import('./components/admin/AdminPanel').PersonalCredentialsPanel>(() => import('./components/admin/AdminPanel'), 'PersonalCredentialsPanel');
const SkillsBrowser = lazyNamed<typeof import('./components/skills/SkillsBrowser').SkillsBrowser>(() => import('./components/skills/SkillsBrowser'), 'SkillsBrowser');
const AgentsPanel = lazyNamed<typeof import('./components/agents/AgentsPanel').AgentsPanel>(() => import('./components/agents/AgentsPanel'), 'AgentsPanel');
const HelpPanel = lazyNamed<typeof import('./components/help/HelpPanel').HelpPanel>(() => import('./components/help/HelpPanel'), 'HelpPanel');
const PublishPanel = lazyNamed<typeof import('./components/publish/PublishPanel').PublishPanel>(() => import('./components/publish/PublishPanel'), 'PublishPanel');
const AIServiceHome = lazyNamed<typeof import('./features/ai-services/AIServiceHome').AIServiceHome>(() => import('./features/ai-services/AIServiceHome'), 'AIServiceHome');
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { OfflineBanner } from './components/common/OfflineBanner';
import { UpdateBanner } from './components/common/UpdateBanner';
import { clearReloadOnceFlag } from './utils/app-version';
import { useAppUpdateCoordinator } from './hooks/useAppUpdateCoordinator';
const PromptEditor = lazyNamed<typeof import('./components/prompts/PromptEditor').PromptEditor>(() => import('./components/prompts/PromptEditor'), 'PromptEditor');
import { SidebarResizeHandle, SIDEBAR_DEFAULT_WIDTH } from './components/layout/ResizeHandle';
import { MobileTabBar } from './components/layout/MobileTabBar';
import { recordRecentPersonalDocument, recordServerPersonalDocumentOpened } from './components/personal-space/personalDocumentRecents';
import { recordMobileDocumentRecent } from './components/files/mobileDocumentRecents';
import { useChatRuntime } from './hooks/useChatRuntime';
import { useUrlSync, parseUrl, findSessionByKey } from './hooks/useUrlSync';
import { useRoomStore } from './stores/room-store';
import { useAiPanelStore } from './stores/ai-panel-store';
import { useOnboarding } from './hooks/useOnboarding';
import { WhatsNewModal } from './components/onboarding/WhatsNewModal';
import { FirstRunInferenceSetup } from './components/onboarding/FirstRunInferenceSetup';
import { TourProvider } from './tours/TourProvider';
import { hasSeenTowerGuide } from './tours/tourState';
import { useTheme } from './hooks/useTheme';
import { useFontSize } from './hooks/useFontSize';
import { useMediaQuery } from './hooks/useMediaQuery';
import { useChatStore } from './stores/chat-store';
import { useSessionStore, type SessionMeta } from './stores/session-store';
import { decideAgentFirstStartup } from './agent-first-startup';

const VIEWER_PANE_DEFAULT_WIDTH = 520;
const VIEWER_PANE_MIN_WIDTH = 220;
const VIEWER_PANE_MAX_WIDTH = 1800;
const VIEWER_PANE_MAIN_MIN_WIDTH = 280;
const VIEWER_PANE_MAX_VIEWPORT_RATIO = 0.86;
const VIEWER_PANE_STORAGE_KEY = 'tower.viewerPaneWidth';
const VIEWER_PANE_MODE_STORAGE_KEY = 'tower.viewerPaneWidthMode';
const VIEWER_PANE_REGULAR_RATIO = 0.4;
const VIEWER_PANE_SPLIT_RATIO = 0.65;

function buildInitialAgentAcademyDraft(): AgentDraftArtifact {
  return {
    status: 'draft',
    templateId: 'agent-academy',
    face: '✨',
    name: 'AI 직원 후보',
    levelTitle: '후보 작성 중',
    role: '',
    expectedExpertise: '',
    tagline: '',
    promise: '',
    capabilities: [],
    responsibilities: [],
    strengths: [],
    sourceHints: [],
    firstTask: '',
    firstMission: '',
    promotionGoal: '',
    needsFromUser: [],
    worksFor: '',
    accountableOutcome: '',
    autonomousActions: [],
    approvalRequiredActions: [],
    onboardingChecks: [],
    assumptions: [],
    capabilityRequirements: { required: [], optional: [], forbidden: [] },
    authorityPolicy: { tier: 'project-write', helpersDefaultTier: 'observe' },
    toolPolicy: { canPublishExternal: false },
  };
}

import { useFileStore } from './stores/file-store';
import { useAgentDraftStore, type AgentDraftArtifact } from './stores/agent-draft-store';
import { usePinStore, type Pin } from './stores/pin-store';
import { usePromptStore, type PromptItem } from './stores/prompt-store';
import { useSettingsStore } from './stores/settings-store';
import { useModelStore, getEngineFromModel, getModelIdForBackend, useSessionAwareModel, reconcileSelectedModel } from './stores/model-store';
import { useGitStore } from './stores/git-store';
import { useProjectStore } from './stores/project-store';
import { useSpaceStore } from './stores/space-store'; // used via .getState()
// normalizeContentBlocks moved to ChatPanel — lazy, only for visible ~20 messages
import { toastSuccess, toastError, toastQuiet } from './utils/toast';
import { getFileExt, isDirectoryLikeTowerPath, normalizeTowerFilePath } from './utils/file-path-links';
import { sessionAttachmentContentUrl, sessionAttachmentIdFromUri } from './utils/session-attachment-links';
import { openPdfInBrowserTab } from './utils/pdf-open';
import { filterPendingSteerMessages } from './utils/pending-steer-filter';
import { cacheSessionMessages, sessionMsgCache } from './utils/session-message-cache';
import { logClientPerf, perfNow } from './utils/client-perf';
import {
  consumeSessionViewerDelivery,
  hasConsumedSessionViewerDelivery,
  markSessionViewerDeliveryConsumed,
  queueSessionViewerDelivery,
  type SessionViewerDelivery,
} from './features/viewer-delivery/sessionViewerDelivery';
import { KanbanBoard } from './components/kanban/KanbanBoard';
import { SchedulePanel } from './components/schedule/SchedulePanel';
import { ScheduleTabView } from './components/schedule/ScheduleTabView';
import { AutomationPanel } from './components/automation/AutomationPanel';
import { HistoryPanel } from './components/history/HistoryPanel';
import { RetiredChannelNotice } from './components/rooms/RetiredChannelNotice';
import { AiPanel } from './components/rooms/AiPanel';
import { InboxPanel } from './components/inbox/InboxPanel';
import { ChallengeTimelinePanel } from './components/work/ChallengeTimelinePanel';
import { FavoritesPanel } from './components/favorites/FavoritesPanel';
import { UploadPanel } from './components/uploads/UploadPanel';
import { BetaPanel } from './components/beta/BetaPanel';
import { getTokenUserId, lastViewedKey } from './utils/session-restore';
import { computeContextUsageStat, fmtTokensShort } from './utils/context-usage';
import { deriveContextMetricFromMessages } from './utils/message-metrics';
// SharedViewer / FileViewerPage moved to main.tsx routes (Phase 1.1, issue #11)
import towerBg from './assets/tower-bg.png';

const API_BASE = '/api';
const STARTUP_SESSION_LIST_LIMIT = 200;
const AUTH_401_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

async function fetchWithRestartTolerantAuth(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  let response = await fetch(input, init);

  // A Nix restart can keep the backend unavailable for several seconds while
  // PM2 stops the old process, starts the pinned closure, and health checks it.
  // Keep the 90-day browser token through that whole recovery window. Only a
  // live backend that repeatedly confirms 401 for 15 seconds may log the user out.
  for (const delayMs of AUTH_401_RETRY_DELAYS_MS) {
    if (response.status !== 401) return response;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    response = await fetch(input, { ...init, cache: 'no-store' });
  }

  return response;
}

// VM-local branding is configured by each server's .env. Add a per-page-load
// cache buster so stale browser cache cannot make one VM show another VM's
// previous branding after env changes or deploys.
const BRANDING_CACHE_BUSTER = Date.now().toString(36);
const CUSTOM_APP_BACKGROUND_SRC = `/api/branding/app-background?v=${BRANDING_CACHE_BUSTER}`;
const CLAUDE_AUTO_COMPACT_WINDOW = 500_000;

type ContextCostPatch = Pick<import('./stores/chat-store').CostInfo, 'contextInputTokens' | 'contextOutputTokens' | 'contextWindowSize' | 'contextEstimatedTokens'>;

function deriveContextCostFromMessages(
  messages: import('./stores/chat-store').ChatMessage[],
  session?: SessionMeta | null,
): ContextCostPatch {
  const modelState = useModelStore.getState();
  const metric = deriveContextMetricFromMessages({
    messages,
    session,
    models: [...modelState.availableModels, ...modelState.piModels, ...modelState.localModels],
  });
  if (!metric) return { contextInputTokens: 0, contextOutputTokens: 0, contextWindowSize: 0, contextEstimatedTokens: 0 };
  return {
    contextInputTokens: metric.contextInput,
    contextOutputTokens: metric.contextOutput,
    contextWindowSize: metric.contextWindow,
    contextEstimatedTokens: metric.contextInput,
  };
}

// 호버 프리페치: 세션에 마우스를 올리면 캐시가 비어있을 때 미리 로딩
// 안전장치: debounce 150ms + 동시 최대 2건 + 32MiB/50세션 LRU
const prefetchingSet = new Set<string>();
const MAX_CONCURRENT_PREFETCH = 2;
let prefetchTimer: ReturnType<typeof setTimeout> | null = null;

function parseStoredMessageContent(content: unknown): any[] {
  if (Array.isArray(content)) return content;
  if (typeof content !== 'string') return [];
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'string') return [{ type: 'text', text: parsed }];
    return [];
  } catch {
    return [{ type: 'text', text: content }];
  }
}

export function prefetchSessionMessages(sessionId: string) {
  // 이미 캐시에 있거나 로딩 중이면 skip
  if (sessionMsgCache.has(sessionId) || prefetchingSet.has(sessionId)) return;
  // 동시 요청 제한
  if (prefetchingSet.size >= MAX_CONCURRENT_PREFETCH) return;

  // 150ms debounce — 빠르게 스크롤해서 지나가는 세션은 무시
  if (prefetchTimer) clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    // 타이머 콜백 시점에 다시 체크 (hover가 이미 떠났을 수 있음)
    if (sessionMsgCache.has(sessionId) || prefetchingSet.has(sessionId)) return;
    if (prefetchingSet.size >= MAX_CONCURRENT_PREFETCH) return;

    prefetchingSet.add(sessionId);
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    Promise.all([
      fetch(`${API_BASE}/sessions/${sessionId}`, { headers }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`${API_BASE}/sessions/${sessionId}/messages?limit=500`, { headers }).then(r => r.ok ? r.json() : null).catch(() => null),
    ])
      .then(([sessionMeta, data]) => {
        if (!data) return;
        const stored = data.messages ?? data;
        if (stored?.length > 0) {
          const msgs = filterLivePendingSteerRows(sessionId, stored.map((m: any) => ({
            id: m.id, shortId: m.short_id || undefined, role: m.role,
            content: parseStoredMessageContent(m.content),
            timestamp: new Date(m.created_at).getTime(),
            updatedAt: m.updated_at ? new Date(m.updated_at).getTime() : undefined,
            completedAt: m.completed_at ? new Date(m.completed_at).getTime() : undefined,
            parentToolUseId: m.parent_tool_use_id,
            durationMs: m.duration_ms || undefined,
            inputTokens: m.input_tokens || undefined,
            outputTokens: m.output_tokens || undefined,
            reasoningTokens: m.metadata?.usage?.reasoning_tokens || undefined,
            contextWindowSize: m.metadata?.usage?.context_window_size || undefined,
            stopReason: m.stop_reason || undefined,
            metadata: m.metadata ?? null,
          })));
          cacheSessionMessages(sessionId, msgs);
          if (useSessionStore.getState().activeSessionId === sessionId) {
            const store = useChatStore.getState();
            store.setCost({
              ...store.cost,
              ...deriveContextCostFromMessages(msgs, sessionMeta || useSessionStore.getState().sessions.find((s) => s.id === sessionId)),
            });
          }
        }
      })
      .catch(() => {})
      .finally(() => prefetchingSet.delete(sessionId));
  }, 150);
}

function filterLivePendingSteerRows(
  sessionId: string,
  messages: import('./stores/chat-store').ChatMessage[],
): import('./stores/chat-store').ChatMessage[] {
  return filterPendingSteerMessages(
    messages,
    useChatStore.getState().pendingInjections[sessionId],
    useSessionStore.getState().streamingSessions.has(sessionId),
  );
}

function findEntry(entries: import('./stores/file-store').FileEntry[], path: string): import('./stores/file-store').FileEntry | null {
  for (const e of entries) {
    if (e.path === path) return e;
    if (e.children) {
      const found = findEntry(e.children, path);
      if (found) return found;
    }
  }
  return null;
}

function agentFirstSidebarMinWidth(): number {
  return 280;
}

function App() {
  const { t } = useTranslation(['auth', 'layout']);
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [authStatus, setAuthStatus] = useState<{ authEnabled: boolean; hasUsers: boolean } | null>(() => {
    // 캐시된 auth 상태로 즉시 시작 → 로딩 화면 없음
    try {
      const c = localStorage.getItem('tower:authCache');
      return c ? JSON.parse(c) : null;
    } catch { return null; }
  });
  const [authError, setAuthError] = useState('');
  const [firstRunInferenceSetup, setFirstRunInferenceSetup] = useState(() => localStorage.getItem('tower:firstRunInferenceSetup') === 'pending');

  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [newSessionCreating, setNewSessionCreating] = useState(false);
  const newSessionCreatingRef = useRef(false);
  const [appBackgroundSrc, setAppBackgroundSrc] = useState(towerBg);
  const isCustomAppBackground = appBackgroundSrc !== towerBg;

  useEffect(() => {
    let cancelled = false;
    // Optional VM branding is advertised by an always-200 capability endpoint.
    // Do not probe the image URL itself: an expected missing image would still
    // surface as a 404/ERR_ABORTED in Chromium DevTools.
    fetch('/api/branding/status', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((status) => {
        if (!cancelled && status?.appBackgroundConfigured) {
          setAppBackgroundSrc(CUSTOM_APP_BACKGROUND_SRC);
        }
      })
      .catch(() => { /* bundled background remains authoritative fallback */ });
    return () => { cancelled = true; };
  }, []);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('sidebarWidth');
    if (!saved) return SIDEBAR_DEFAULT_WIDTH;
    const parsed = parseInt(saved, 10);
    if (!Number.isFinite(parsed)) return SIDEBAR_DEFAULT_WIDTH;
    // Earlier defaults (260px, then 224px) were single-column widths. Treat
    // those exact values as uncustomized so existing desktop users receive the
    // Agent-first two-column rail without overriding deliberate manual widths.
    if (parsed === 260 || parsed === 224) return SIDEBAR_DEFAULT_WIDTH;
    // The Agent-first desktop sidebar is a two-column navigator. Widths below
    // 280px leave the conversation pane unusably narrow after the AI rail.
    return Math.max(agentFirstSidebarMinWidth(), parsed);
  });

  const handleSidebarResize = useCallback((width: number) => {
    const agentFirst = useSettingsStore.getState().serverConfig?.agentFirstEnabled === true;
    const nextWidth = agentFirst ? Math.max(agentFirstSidebarMinWidth(), width) : width;
    setSidebarWidth(nextWidth);
    localStorage.setItem('sidebarWidth', String(nextWidth));
  }, []);
  const splitTabId = useFileStore((s) => s.splitTabId);
  const contextPanelOpen = useFileStore((s) => s.contextPanelOpen);
  const setContextPanelOpen = useFileStore((s) => s.setContextPanelOpen);
  const contextPanelTab = useFileStore((s) => s.contextPanelTab);
  const activeViewerTab = useFileStore((s) => s.splitTabId ? s.tabs.find((t) => t.id === s.splitTabId) ?? null : null);
  const activeViewerTabLanguage = activeViewerTab?.language ?? null;
  const extraTabs = useFileStore(useShallow((s) => s.tabs.filter((tab) => tab.pane === 'extra' || tab.id === s.splitTabId)));
  const reorderTabs = useFileStore((s) => s.reorderTabs);
  const activeFilePane = useFileStore((s) => s.activeFilePane);
  const setActiveFilePane = useFileStore((s) => s.setActiveFilePane);
  const calculateViewerPaneMaxWidth = useCallback(() => {
    const availableWidth = Math.max(VIEWER_PANE_MIN_WIDTH, window.innerWidth - sidebarWidth - 80);
    const viewportRatioMax = Math.floor(availableWidth * VIEWER_PANE_MAX_VIEWPORT_RATIO);
    const mainPreservingMax = availableWidth - VIEWER_PANE_MAIN_MIN_WIDTH;
    return Math.max(VIEWER_PANE_MIN_WIDTH, Math.min(VIEWER_PANE_MAX_WIDTH, viewportRatioMax, mainPreservingMax));
  }, [sidebarWidth]);
  const calculateViewerPaneWidth = useCallback((ratio: number) => {
    const availableWidth = Math.max(VIEWER_PANE_MIN_WIDTH, window.innerWidth - sidebarWidth - 80);
    return Math.min(calculateViewerPaneMaxWidth(), Math.max(VIEWER_PANE_MIN_WIDTH, Math.round(availableWidth * ratio)));
  }, [calculateViewerPaneMaxWidth, sidebarWidth]);
  const viewerResizeGuideRef = useRef<HTMLDivElement>(null);
  const [viewerResizing, setViewerResizing] = useState(false);
  const [viewerPaneWidth, setViewerPaneWidth] = useState(() => {
    const parsed = Number(localStorage.getItem(VIEWER_PANE_STORAGE_KEY));
    if (!Number.isFinite(parsed) || parsed <= 0) return calculateViewerPaneWidth(VIEWER_PANE_REGULAR_RATIO);
    return Math.min(VIEWER_PANE_MAX_WIDTH, Math.max(VIEWER_PANE_MIN_WIDTH, parsed));
  });
  const [viewerPaneWidthMode, setViewerPaneWidthMode] = useState<'regular' | 'split'>(() => {
    const raw = localStorage.getItem(VIEWER_PANE_MODE_STORAGE_KEY);
    return raw === 'split' ? 'split' : 'regular';
  });
  const [viewerTabMenu, setViewerTabMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [viewerShareFilePath, setViewerShareFilePath] = useState<string | null>(null);
  const [aiQuickPanelOpen, setAiQuickPanelOpen] = useState(false);
  const viewerTabbarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const toggle = () => setAiQuickPanelOpen((open) => !open);
    window.addEventListener('tower-toggle-ai-quick-panel', toggle);
    return () => window.removeEventListener('tower-toggle-ai-quick-panel', toggle);
  }, []);
  const artifactFlashTimerRef = useRef<number | null>(null);
  const [viewerTabbarOverflow, setViewerTabbarOverflow] = useState({ left: false, right: false });
  const [artifactFlashActive, setArtifactFlashActive] = useState(false);
  const [viewerAffordanceVisible, setViewerAffordanceVisible] = useState(() => localStorage.getItem('tower.viewerAffordanceVisible') === 'true');
  // Personal notes make the Viewer an always-available workspace, even before
  // the first file tab exists. The collapsed rail becomes the entry point.
  const viewerAvailable = true;
  const isMarkdownSplitViewer = contextPanelOpen && activeViewerTabLanguage === 'markdown' && contextPanelTab === 'split';
  const isMobile = useSessionStore((s) => s.isMobile);

  useEffect(() => {
    if (!splitTabId || viewerAffordanceVisible) return;
    setViewerAffordanceVisible(true);
    localStorage.setItem('tower.viewerAffordanceVisible', 'true');
  }, [splitTabId, viewerAffordanceVisible]);

  useEffect(() => {
    if (!viewerTabMenu) return;
    const close = () => setViewerTabMenu(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('resize', close);
    };
  }, [viewerTabMenu]);

  const triggerArtifactFlash = useCallback(() => {
    if (artifactFlashTimerRef.current) window.clearTimeout(artifactFlashTimerRef.current);
    setArtifactFlashActive(false);
    window.requestAnimationFrame(() => {
      setArtifactFlashActive(true);
      artifactFlashTimerRef.current = window.setTimeout(() => {
        setArtifactFlashActive(false);
        artifactFlashTimerRef.current = null;
      }, 2000);
    });
  }, []);

  useEffect(() => () => {
    if (artifactFlashTimerRef.current) window.clearTimeout(artifactFlashTimerRef.current);
  }, []);

  useEffect(() => {
    const desiredMode = isMarkdownSplitViewer ? 'split' : 'regular';
    if (viewerPaneWidthMode === desiredMode) return;
    const nextWidth = calculateViewerPaneWidth(desiredMode === 'split' ? VIEWER_PANE_SPLIT_RATIO : VIEWER_PANE_REGULAR_RATIO);
    setViewerPaneWidth(nextWidth);
    localStorage.setItem(VIEWER_PANE_STORAGE_KEY, String(nextWidth));
    localStorage.setItem(VIEWER_PANE_MODE_STORAGE_KEY, desiredMode);
    setViewerPaneWidthMode(desiredMode);
  }, [calculateViewerPaneWidth, isMarkdownSplitViewer, viewerPaneWidthMode]);
  const updateViewerTabbarOverflow = useCallback(() => {
    const el = viewerTabbarRef.current;
    if (!el) return;
    const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
    setViewerTabbarOverflow({
      left: el.scrollLeft > 2,
      right: el.scrollLeft < maxScrollLeft - 2,
    });
  }, []);
  const scrollViewerTabbarBy = useCallback((direction: -1 | 1) => {
    viewerTabbarRef.current?.scrollBy({ left: direction * 180, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const el = viewerTabbarRef.current;
    if (!el) return;
    updateViewerTabbarOverflow();
    el.addEventListener('scroll', updateViewerTabbarOverflow, { passive: true });
    const resizeObserver = new ResizeObserver(updateViewerTabbarOverflow);
    resizeObserver.observe(el);
    return () => {
      el.removeEventListener('scroll', updateViewerTabbarOverflow);
      resizeObserver.disconnect();
    };
  }, [extraTabs.length, updateViewerTabbarOverflow, viewerPaneWidth]);

  useEffect(() => {
    if (!splitTabId) return;
    window.requestAnimationFrame(() => {
      const tab = viewerTabbarRef.current?.querySelector<HTMLElement>(`[data-viewer-tab-id="${CSS.escape(splitTabId)}"]`);
      tab?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      updateViewerTabbarOverflow();
    });
  }, [splitTabId, updateViewerTabbarOverflow]);

  const viewerTabSensors = useSensors(useSensor(PointerSensor, { activationConstraint: isMobile ? { delay: 180, tolerance: 8 } : { distance: 6 } }));
  const handleViewerTabDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeId = String(active.id).replace(/^viewer-file:/, '');
    const targetId = String(over.id).replace(/^viewer-file:/, '');
    const store = useFileStore.getState();
    const fromIndex = store.tabs.findIndex((t) => t.id === activeId);
    const toIndex = store.tabs.findIndex((t) => t.id === targetId);
    if (fromIndex >= 0 && toIndex >= 0) reorderTabs(fromIndex, toIndex);
  }, [reorderTabs]);
  const handleViewerPaneResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = viewerPaneWidth;
    const maxWidthForViewport = calculateViewerPaneMaxWidth();
    let nextWidth = startWidth;
    let animationFrame = 0;
    const renderPreview = () => {
      animationFrame = 0;
      if (viewerResizeGuideRef.current) {
        viewerResizeGuideRef.current.style.transform = `translate3d(${startWidth - nextWidth}px, 0, 0)`;
      }
    };
    const onPointerMove = (moveEvent: PointerEvent) => {
      nextWidth = Math.min(maxWidthForViewport, Math.max(VIEWER_PANE_MIN_WIDTH, startWidth - (moveEvent.clientX - startX)));
      if (!animationFrame) animationFrame = window.requestAnimationFrame(renderPreview);
    };
    const onPointerUp = (upEvent: PointerEvent) => {
      nextWidth = Math.min(maxWidthForViewport, Math.max(VIEWER_PANE_MIN_WIDTH, startWidth - (upEvent.clientX - startX)));
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      setViewerPaneWidth(nextWidth);
      setViewerResizing(false);
      localStorage.setItem(VIEWER_PANE_STORAGE_KEY, String(Math.round(nextWidth)));
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    setViewerResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
  }, [calculateViewerPaneMaxWidth, viewerPaneWidth]);

  const openTowerFileInBrowserTab = useCallback((path: string) => {
    if (getFileExt(path) === 'pdf') {
      openPdfInBrowserTab(path);
      return;
    }
    window.open(`/file-viewer?path=${encodeURIComponent(path)}`, '_blank', 'noopener,noreferrer');
  }, []);

  const { sendMessage, requestSafeStop, abort, setActiveSession, requestFile, requestFileTree, saveFile, answerQuestion, connected, loadMoreMessages } = useChatRuntime(authStatus?.authEnabled === false || !!token);
  const { theme } = useTheme();
  useFontSize();
  // Debounce isMobile transitions: a 32px BottomBar ↔ 64px MobileTabBar swap
  // is jarring if it flips on micro viewport jitter (zoom, scrollbar,
  // mid-reflow frame measurements). 300ms is short enough that real
  // resize/rotation still feels instant, long enough to absorb noise.
  const isMobileQuery = useMediaQuery('(max-width: 768px)', { debounceMs: 300 });
  const mobileContextOpen = useSessionStore((s) => s.mobileContextOpen);

  // Prevent browser from opening dropped files globally
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  // Sync media query to store. Automation management is desktop-only: if a
  // restored URL/state points at it on mobile, return to the stable AI Team home.
  useEffect(() => {
    const store = useSessionStore.getState();
    store.setIsMobile(isMobileQuery);
    if (isMobileQuery) {
      store.setSidebarOpen(false);
      if (store.activeView === 'schedules' || store.activeView === 'automations' || store.mobileTab === 'schedule') {
        store.setMobileTab('ai');
        store.setActiveView('aiTeam');
      }
    }
  }, [isMobileQuery]);

  // 모바일: 브라우저 뒤로가기로 파일 뷰어 닫기
  useEffect(() => {
    const handlePopState = (_e: PopStateEvent) => {
      const store = useSessionStore.getState();
      if (store.isMobile && store.mobileContextOpen) {
        // popstate에서 호출 → history.back() 중복 방지를 위해 true 전달
        store.closeMobileContext(true);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const sidebarOpen = useSessionStore((s) => s.sidebarOpen);
  const setSidebarOpen = useSessionStore((s) => s.setSidebarOpen);
  const sidebarTab = useSessionStore((s) => s.sidebarTab);
  const lastSidebarTab = useSessionStore((s) => s.lastSidebarTab);
  const setSidebarTab = useSessionStore((s) => s.setSidebarTab);
  const setLastSidebarTab = useSessionStore((s) => s.setLastSidebarTab);
  const projects = useProjectStore((s) => s.projects);
  const aiPanelOpen = useAiPanelStore((s) => s.open);
  const aiPanelContextType = useAiPanelStore((s) => s.contextType);
  const aiServicesEnabled = useSettingsStore((s) => s.serverConfig?.aiServicesEnabled === true);
  const settingsOpen = useSettingsStore((s) => s.isOpen);
  const skillsBrowserOpen = useSettingsStore((s) => s.skillsBrowserOpen);
  const agentsPanelOpen = useSettingsStore((s) => s.agentsPanelOpen);
  const helpOpen = useSettingsStore((s) => s.helpOpen);
  const cadWorkbenchBetaEnabled = useSettingsStore((s) => !!s.serverConfig?.cadWorkbenchBetaEnabled);
  // Global multi-tab shell (v2, 2026-05-22):
  //   activeTabId === null → 채팅 슬롯 active (본문 = ChatPanel)
  //   activeTabId !== null → 그 파일 탭 active (본문 = ContextPanel)
  // See: workspace/decisions/2026-05-22-global-multi-tab-shell.md
  const activeTabId = useFileStore((s) => s.activeTabId);
  const activeFileTab = useFileStore((s) => s.activeTabId ? s.tabs.find((tab) => tab.id === s.activeTabId) ?? null : null);
  const activeSystemTabId = useFileStore((s) => s.activeSystemTabId);
  const activeSystemTab = useFileStore((s) => s.systemTabs.find((tab) => tab.id === s.activeSystemTabId) ?? null);
  const activeSystemTabKind = activeSystemTab?.kind ?? null;
  const activeSystemTabRefId = activeSystemTab?.refId ?? null;
  const clearMessages = useChatStore((s) => s.clearMessages);
  const setActiveSessionId = useSessionStore((s) => s.setActiveSessionId);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const appSessions = useSessionStore((s) => s.sessions);
  const activeSessionProjectId = appSessions.find((s) => s.id === activeSessionId)?.projectId || null;
  const capabilityProjectId = useSettingsStore((s) => s.capabilityProjectId);
  const projectHomeProject = activeSystemTabKind === 'projectFiles' && activeSystemTabRefId
    ? projects.find((p) => p.id === activeSystemTabRefId) || null
    : null;
  const lastAutoOpenedCadAiPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!cadWorkbenchBetaEnabled || !activeSessionId || activeFileTab?.language !== 'cad') return;
    const filePath = activeFileTab.path;
    const autoKey = `${activeSessionId}:${filePath}`;
    if (lastAutoOpenedCadAiPathRef.current === autoKey) return;
    lastAutoOpenedCadAiPathRef.current = autoKey;
    const store = useAiPanelStore.getState();
    store.setContext('session', activeSessionId, {
      path: filePath,
      title: filePath.split('/').pop() || 'CAD drawing',
      language: 'cad',
    });
    store.setActiveThreadId(null);
    store.setMessages([]);
    store.setPendingQuestion(null);
    store.setOpen(true);
  }, [activeFileTab?.language, activeFileTab?.path, activeSessionId, cadWorkbenchBetaEnabled]);

  const addSession = useSessionStore((s) => s.addSession);
  const removeSession = useSessionStore((s) => s.removeSession);
  const setRecentSessions = useSessionStore((s) => s.setRecentSessions);
  const resetProjectSessionHydration = useSessionStore((s) => s.resetProjectSessionHydration);
  const sessionListRefreshRef = useRef({ lastAt: 0, inFlight: false });
  const startupSessionsLoadRef = useRef<{ key: string | null; inFlight: boolean }>({ key: null, inFlight: false });

  const refreshSessionList = useCallback(async (
    reason: 'ws-connected' | 'visibility' | 'focus' | 'sidebar-tab',
    options?: { minIntervalMs?: number; force?: boolean },
  ) => {
    if (authStatus === null) return;
    if (authStatus.authEnabled && !token) return;

    const now = Date.now();
    const minIntervalMs = options?.minIntervalMs ?? 5000;
    const gate = sessionListRefreshRef.current;
    if (gate.inFlight) return;
    if (!options?.force && now - gate.lastAt < minIntervalMs) return;

    gate.inFlight = true;
    gate.lastAt = now;
    const refreshStartedAt = perfNow();
    try {
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetchWithRestartTolerantAuth(`${API_BASE}/sessions?limit=${STARTUP_SESSION_LIST_LIMIT}`, { headers });
      const responseMs = Math.round(perfNow() - refreshStartedAt);
      if (res.status === 401) {
        localStorage.removeItem('token');
        setToken(null);
        return;
      }
      if (!res.ok) {
        logClientPerf('session-list-refresh', { reason, status: res.status, responseMs, elapsedMs: responseMs }, { thresholdMs: 800 });
        return;
      }
      const parseStartedAt = perfNow();
      const data = await res.json();
      const parseMs = Math.round(perfNow() - parseStartedAt);
      if (!Array.isArray(data)) return;
      logClientPerf('session-list-refresh', {
        reason,
        status: res.status,
        sessionCount: data.length,
        requestedLimit: STARTUP_SESSION_LIST_LIMIT,
        responseMs,
        parseMs,
        elapsedMs: Math.round(perfNow() - refreshStartedAt),
      }, { thresholdMs: 800 });

      // The response is only the global recent window. Reconcile that window
      // without deleting complete project lists that were hydrated separately.
      // Decision: workspace/decisions/2026-08-20-project-session-hydration-reconciliation.md
      setRecentSessions(data);
    } catch (err) {
      console.warn(`[app] session list reconciliation failed (${reason}):`, err);
    } finally {
      sessionListRefreshRef.current.inFlight = false;
    }
  }, [authStatus, token, setRecentSessions]);

  // 백그라운드에서 auth 상태 검증 (캐시로 이미 렌더링된 후 조용히 실행)
  useEffect(() => {
    fetch(`${API_BASE}/auth/status`)
      .then((r) => {
        if (r.status === 429) {
          // Public auth status should normally not be rate-limited. Treat an
          // older deployment's transient limiter response as unknown status,
          // but never turn it into an implicit logout.
          return { authEnabled: true, hasUsers: true };
        }
        return r.json();
      })
      .then(async (status) => {
        // 캐시 갱신
        try { localStorage.setItem('tower:authCache', JSON.stringify(status)); } catch {}

        // 토큰이 있으면 실제 유효성 확인 (401만 로그아웃 — 네트워크 에러는 유지)
        if (status.authEnabled && token) {
          try {
            const r = await fetchWithRestartTolerantAuth(`${API_BASE}/auth/check`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (r.status === 401) {
              localStorage.removeItem('token');
              setToken(null);
            }
          } catch {
            // 네트워크 에러 → 오프라인일 수 있음, 토큰 유지
          }
        }
        setAuthStatus((prev) => (
          prev && prev.authEnabled === status.authEnabled && prev.hasUsers === status.hasUsers ? prev : status
        ));
      })
      .catch(() => {
        // 서버 응답 없음 → 캐시 상태 그대로 유지 (오프라인 허용)
        if (authStatus === null) setAuthStatus({ authEnabled: false, hasUsers: false });
      });
  }, []);


  const handleLogin = async (
    username: string,
    password: string,
    opts?: { displayName?: string; affiliation?: string },
  ) => {
    setAuthError('');
    const isSetup = !authStatus?.hasUsers;
    const endpoint = isSetup ? '/auth/setup' : '/auth/login';
    try {
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // isSetup 일 때만 displayName/affiliation 같이 전달.
        body: JSON.stringify({ username, password, ...(isSetup && opts ? opts : {}) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || 'Login failed');
        return;
      }
      localStorage.setItem('token', data.token);
      if (data.user?.id) localStorage.setItem('userId', String(data.user.id));
      if (data.user?.username) localStorage.setItem('username', data.user.username);
      // 2026-05-22: localStorage('userRole') 미러링 폐기. JWT payload 가 단일 source.
      // 모든 UI gate 는 utils/auth.ts 의 헬퍼를 통해 token 에서 직접 읽는다.
      setToken(data.token);
      // 로그인 성공 시 캐시 갱신 → 다음 앱 시작 시 로딩 없이 바로 메인 화면
      try { localStorage.setItem('tower:authCache', JSON.stringify({ authEnabled: true, hasUsers: true })); } catch {}
      if (isSetup) {
        localStorage.setItem('tower:firstRunInferenceSetup', 'pending');
        setFirstRunInferenceSetup(true);
        setAuthStatus({ ...authStatus!, hasUsers: true });
      }
    } catch {
      setAuthError(t('auth:cannotConnect'));
    }
  };

  const handleSignup = async (
    inviteCode: string,
    username: string,
    password: string,
    opts: { displayName: string; affiliation?: string },
  ): Promise<{ ok: boolean; message?: string }> => {
    setAuthError('');
    try {
      const res = await fetch(`${API_BASE}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteCode, username, password, ...opts }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, message: data.error || t('auth:signupFailed') };
      if (data.approvalMode === 'manual' || data.user?.approval_status === 'pending') {
        return { ok: true, message: t('auth:signupPendingApproval') };
      }
      return { ok: true, message: t('auth:signupSubmitted') };
    } catch {
      return { ok: false, message: t('auth:cannotConnect') };
    }
  };

  // Create a session in DB and return it (reusable)
  // label: when set, the new session is tagged with this deck label server-side
  // so it appears inside the target deck group without a second roundtrip.
  const createSessionInDb = useCallback(async (name?: string, projectId?: string, label?: string, visibility?: 'private' | 'project'): Promise<SessionMeta | null> => {
    try {
      // Resolve projectId: explicit > active session > most recent session with project
      let resolvedProjectId = projectId;
      if (!resolvedProjectId) {
        const { sessions: allSessions, activeSessionId } = useSessionStore.getState();
        const activeSess = allSessions.find((s) => s.id === activeSessionId);
        resolvedProjectId = activeSess?.projectId || undefined;
        if (!resolvedProjectId) {
          // Fallback: most recently created session that has a projectId
          const recent = [...allSessions]
            .filter((s) => s.projectId && !s.roomId)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          if (recent.length > 0) resolvedProjectId = recent[0].projectId!;
        }
        if (!resolvedProjectId) {
          // Final fallback: never create a projectless session. Use General when
          // there is no active/recent project context.
          const general = useProjectStore.getState().projects.find((p) => p.name.toLowerCase() === 'general' || p.rootPath?.endsWith('/general'));
          resolvedProjectId = general?.id || undefined;
        }
      }

      // If creating in a project with rootPath, use that as cwd
      // Otherwise inherit cwd from current active session
      let cwd: string | undefined;
      if (resolvedProjectId) {
        const project = useProjectStore.getState().projects.find((p) => p.id === resolvedProjectId);
        if (project?.rootPath) cwd = project.rootPath;
      }
      if (!cwd) {
        const currentSessions = useSessionStore.getState().sessions;
        const currentActiveId = useSessionStore.getState().activeSessionId;
        const currentSession = currentSessions.find((s) => s.id === currentActiveId);
        cwd = currentSession?.cwd || undefined;
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const selectedModel = useModelStore.getState().selectedModel;
      const engine = getEngineFromModel(selectedModel);
      const modelUsed = getModelIdForBackend(selectedModel);
      const body: Record<string, any> = { name: name || `Session ${new Date().toLocaleString('en-US')}`, cwd, engine, modelUsed };
      if (resolvedProjectId) body.projectId = resolvedProjectId;
      if (label && label.trim()) body.label = label.trim();
      if (visibility) body.visibility = visibility;
      const res = await fetch(`${API_BASE}/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const session = await res.json();
        addSession(session);
        return session;
      }
    } catch (err) { console.warn('[app] createSessionInDb failed:', err); }
    return null;
  }, [token, addSession]);

  const handleNewSession = useCallback(async (projectId?: string, label?: string) => {
    // Don't abort streaming — let the SDK query run in background and save to DB.
    // On mobile, cover the previous conversation immediately while the POST is
    // pending so a slow connection never makes another session look selected.
    if (newSessionCreatingRef.current) return;
    newSessionCreatingRef.current = true;
    setNewSessionCreating(true);
    useChatStore.getState().setStreaming(false);
    useChatStore.getState().clearAttachments();
    useChatStore.getState().setSessionLoading(false);
    try {
      const session = await createSessionInDb(undefined, projectId, label);
      if (!session) {
        toastError(t('layout:newSessionCreateFailed'));
        return;
      }
      setActiveSessionId(session.id);
      useChatStore.getState().setSessionId(session.id);
      useChatStore.getState().setEngineSessionId(null);
      clearMessages();
      setActiveSession(session.id);
      // v3 (path B): 새 세션도 채팅 탭으로 즉시 보이게. 파일 탭에 머물러 있던
      // 경우 채팅 모드(activeTabId=null)로 전환까지 같이.
      useFileStore.getState().openChatTab(session.id);
      useSessionStore.getState().setActiveView('chat');
      // Desktop keeps the teammate list visible after creating a conversation,
      // but mobile drawer callers close it immediately. Do not reopen the
      // drawer after the async POST finishes.
      if (!useSessionStore.getState().isMobile) {
        useSessionStore.getState().setSidebarOpen(true);
      }
    } finally {
      newSessionCreatingRef.current = false;
      setNewSessionCreating(false);
    }
  }, [createSessionInDb, setActiveSessionId, clearMessages, setActiveSession]);

  const handleNewSessionInFolder = useCallback(async (cwd: string) => {
    // Don't abort streaming — let the SDK query run in background and save to DB
    useChatStore.getState().setStreaming(false);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`${API_BASE}/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: `Session ${new Date().toLocaleString('en-US')}`, cwd }),
      });
      if (res.ok) {
        const session = await res.json();
        addSession(session);
        setActiveSessionId(session.id);
        useChatStore.getState().setSessionId(session.id);
        useChatStore.getState().setEngineSessionId(null);
        clearMessages();
        setActiveSession(session.id);
        useFileStore.getState().openChatTab(session.id);
      }
    } catch (err) { console.warn('[app] handleNewSessionInFolder failed:', err); }
  }, [token, addSession, setActiveSessionId, clearMessages, setActiveSession]);

  const handleSelectSession = useCallback(async (session: SessionMeta, options?: { preserveNavigation?: boolean }) => {
    // v3 (2026-05-24, path B): selecting a session anywhere (sidebar, inbox,
    // kanban, restore) ensures a chat tab for it + enters chat mode
    // (activeTabId=null). openChatTab is idempotent (focuses if already open).
    // shift/middle-click "new tab" is handled by SessionItem calling openChatTab
    // with forceNew *before* this runs. See: 2026-05-22-global-multi-tab-shell.md
    useFileStore.getState().openChatTab(session.id);

    // Sidebar/inbox/kanban selections may intentionally navigate to the AI explorer.
    // Main-tab clicks should only change the central work target and preserve the top menu + sidebar pair.
    if (!options?.preserveNavigation) {
      if (useSessionStore.getState().activeView !== 'chat') {
        useSessionStore.getState().setActiveView('chat');
      }
      if (useSessionStore.getState().sidebarTab !== 'sessions') {
        useSessionStore.getState().setSidebarTab('sessions');
      }
    }

    // Skip if already on this session (but optional view switch above still runs)
    const currentId = useSessionStore.getState().activeSessionId;
    if (currentId === session.id) return;
    const selectStartedAt = perfNow();

    // Capture synchronously before clearMessages()/activeSessionId changes. Scroll
    // and Virtuoso range callbacks can be throttled behind React/rAF, so relying
    // on their latest snapshot alone loses the exact viewport during fast tab clicks.
    window.dispatchEvent(new CustomEvent('tower-capture-chat-viewport'));

    // DON'T abort streaming — let the SDK query run in the background and save to DB.
    // When user switches back, messages are loaded from DB.
    const chatStore = useChatStore.getState();
    chatStore.setStreaming(false);
    chatStore.clearAttachments();

    // Clear the old message list BEFORE publishing the new session id to any
    // view/store. External-store updates are not guaranteed to be observed as
    // one atomic React render; if activeSessionId/sessionId flips while the old
    // `messages` array is still present, users see a scary stale afterimage of
    // the previous session. Prefer a brief empty/skeleton state over showing the
    // wrong session's content. See GitHub issue #74.
    chatStore.setSessionLoading(true);
    clearMessages();

    setActiveSessionId(session.id);
    localStorage.setItem(lastViewedKey(getTokenUserId(token)), session.id);
    useChatStore.getState().setSessionId(session.id);

    const PAGE_SIZE = 500;
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    // ── Cache hit: replace after the old session has already been cleared ──
    const cached = sessionMsgCache.get(session.id);
    if (cached && cached.length > 0) {
      const store = useChatStore.getState();
      store.setSessionLoading(false);
      store.setMessages(cached, { replayPresentFile: true });
      store.setCost({ totalCost: 0, inputTokens: 0, outputTokens: 0, cumulativeInputTokens: 0, cumulativeOutputTokens: 0, turnCount: 0, ...deriveContextCostFromMessages(cached, session) });
      store.setRateLimit(null);
      store.setPendingQuestion(null);
      store.setLastTurnMetrics(null);
      logClientPerf('session-select-cache-hit', {
        sessionId: session.id,
        messageCount: cached.length,
        elapsedMs: Math.round(perfNow() - selectStartedAt),
      }, { thresholdMs: 250 });

      // Use optimistic engineSessionId — don't await
      const optimisticEngineSessionId = session.engineSessionId || session.piSessionFile || session.claudeSessionId || null;
      useChatStore.getState().setEngineSessionId(optimisticEngineSessionId);
      setActiveSession(session.id, optimisticEngineSessionId);

      // Background: parallel refresh of session metadata + messages
      const refreshStartedAt = perfNow();
      Promise.all([
        fetch(`${API_BASE}/sessions/${session.id}`, { headers }).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`${API_BASE}/sessions/${session.id}/messages?limit=${PAGE_SIZE}`, { headers }).then(r => r.ok ? r.json() : null).catch(() => null),
      ]).then(([freshSession, msgData]) => {
        logClientPerf('session-select-cache-refresh', {
          sessionId: session.id,
          messageCount: Array.isArray(msgData) ? msgData.length : (Array.isArray(msgData?.messages) ? msgData.messages.length : 0),
          elapsedMs: Math.round(perfNow() - refreshStartedAt),
        }, { thresholdMs: 800 });
        if (useSessionStore.getState().activeSessionId !== session.id || useChatStore.getState().sessionId !== session.id) return;
        // Update engineSessionId if changed
        if ((freshSession?.engineSessionId || freshSession?.piSessionFile || freshSession?.claudeSessionId) && (freshSession.engineSessionId || freshSession.piSessionFile || freshSession.claudeSessionId) !== optimisticEngineSessionId) {
          useChatStore.getState().setEngineSessionId(freshSession.engineSessionId || freshSession.piSessionFile || freshSession.claudeSessionId);
          useSessionStore.getState().updateSessionMeta(session.id, { engineSessionId: freshSession.engineSessionId || freshSession.piSessionFile || freshSession.claudeSessionId, claudeSessionId: freshSession.claudeSessionId });
        }
        // Update messages — skip setMessages if IDs haven't changed (prevents Virtuoso scroll drift)
        if (msgData) {
          const stored = msgData.messages ?? msgData;
          if (stored?.length > 0) {
            const msgs = filterLivePendingSteerRows(session.id, stored.map((m: any) => ({
              id: m.id, shortId: m.short_id || undefined, role: m.role,
              content: parseStoredMessageContent(m.content),
              timestamp: new Date(m.created_at).getTime(),
              updatedAt: m.updated_at ? new Date(m.updated_at).getTime() : undefined,
              completedAt: m.completed_at ? new Date(m.completed_at).getTime() : undefined,
              parentToolUseId: m.parent_tool_use_id,
              durationMs: m.duration_ms || undefined,
              inputTokens: m.input_tokens || undefined,
              outputTokens: m.output_tokens || undefined,
              reasoningTokens: m.metadata?.usage?.reasoning_tokens || undefined,
              contextWindowSize: m.metadata?.usage?.context_window_size || undefined,
              stopReason: m.stop_reason || undefined,
              metadata: m.metadata ?? null,
            })));
            cacheSessionMessages(session.id, msgs);

            // Replace messages when either:
            //   - IDs changed (new message appeared / order shifted), OR
            //   - the last message's content shape changed (same id but more
            //     blocks / longer trailing text → "이미 끝난 답변이 새로 작성
            //     안 되어 있던 경우" 케이스. The cache held a frozen earlier
            //     state of the same message id.)
            // Mirror of mergeProducesNoChange logic in useChatRuntime.ts (6차)
            // so this cache-hit path doesn't have the sibling defect.
            const currentMsgs = useChatStore.getState().messages;
            const currentIds = currentMsgs.map(m => m.id).join(',');
            const freshIds = msgs.map((m: any) => m.id).join(',');
            const idsChanged = currentIds !== freshIds;
            let lastContentChanged = false;
            if (!idsChanged && msgs.length > 0 && currentMsgs.length > 0) {
              const cur: any = currentMsgs[currentMsgs.length - 1];
              const fresh: any = msgs[msgs.length - 1];
              const cL = Array.isArray(cur.content) ? cur.content.length : 0;
              const fL = Array.isArray(fresh.content) ? fresh.content.length : 0;
              if (cL !== fL) {
                lastContentChanged = true;
              } else if (cL > 0) {
                const cb: any = cur.content[cL - 1];
                const fb: any = fresh.content[fL - 1];
                const ct = typeof cb?.text === 'string' ? cb.text : '';
                const ft = typeof fb?.text === 'string' ? fb.text : '';
                if (ct.length !== ft.length) lastContentChanged = true;
              }
            }
            if (idsChanged || lastContentChanged) {
              useChatStore.getState().setMessages(msgs, { replayPresentFile: true });
              useChatStore.getState().setCost({ totalCost: 0, inputTokens: 0, outputTokens: 0, cumulativeInputTokens: 0, cumulativeOutputTokens: 0, turnCount: 0, ...deriveContextCostFromMessages(msgs, freshSession || session) });
              useChatStore.getState().bumpScrollGeneration();
            }
            useChatStore.getState().setHasMoreMessages(msgData.hasMore ?? false);
            useChatStore.getState().setOldestMessageId(msgData.oldestId ?? null);
          }
        }
      });
      return;
    }

    // ── Cache miss: clear state then fetch ──
    // Tell the backend immediately that this websocket moved to the new session.
    // Previously this happened only after `/full` returned; if the user sent a
    // first message during that gap, the backend could keep the socket subscribed
    // to the previous session's stream.
    const optimisticEngineSessionId = session.engineSessionId || session.piSessionFile || session.claudeSessionId || null;
    useChatStore.getState().setEngineSessionId(optimisticEngineSessionId);
    setActiveSession(session.id, optimisticEngineSessionId);

    // sessionLoading drives the skeleton in ChatPanel (`messages.length === 0
    // && sessionLoading`). If the fetch below hangs (background tab throttle,
    // server restart, dropped connection) sessionLoading would be stuck true
    // forever and the user would see the skeleton until full reload — exactly
    // the "10 minutes later, skeleton never ends" symptom.
    //
    // Two safety nets:
    //   1. AbortController + 10s timeout — fetch can't hang silently.
    //   2. finally block — sessionLoading is ALWAYS reset, on every code path
    //      (success, abort, exception, non-2xx). Note: this handler already
    //      cleared the previous session before publishing the new id, so there
    //      is no stale-message frame while the cache/fetch resolves.

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const fetchStartedAt = perfNow();
      const res = await fetch(
        `${API_BASE}/sessions/${session.id}/full?limit=${PAGE_SIZE}`,
        { headers, signal: controller.signal }
      );
      const responseMs = Math.round(perfNow() - fetchStartedAt);
      if (res.ok) {
        const parseStartedAt = perfNow();
        const data = await res.json();
        const parseMs = Math.round(perfNow() - parseStartedAt);
        logClientPerf('session-select-fetch-full', {
          sessionId: session.id,
          status: res.status,
          messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
          responseMs,
          parseMs,
          elapsedMs: Math.round(perfNow() - selectStartedAt),
        }, { thresholdMs: 800 });
        // A slower session load may finish after the user has already selected
        // another tab. Never let that stale response replace the new transcript.
        if (useSessionStore.getState().activeSessionId !== session.id || useChatStore.getState().sessionId !== session.id) return;

        // Apply engineSessionId
        const resolvedEngineSessionId = data.session?.engineSessionId || data.session?.piSessionFile || data.session?.claudeSessionId || session.engineSessionId || session.piSessionFile || session.claudeSessionId || null;
        if (data.session?.engineSessionId || data.session?.piSessionFile || data.session?.claudeSessionId) {
          useSessionStore.getState().updateSessionMeta(session.id, {
            engineSessionId: data.session.engineSessionId || data.session.piSessionFile || data.session.claudeSessionId,
            claudeSessionId: data.session.claudeSessionId,
          });
        }
        if (resolvedEngineSessionId !== optimisticEngineSessionId) {
          useChatStore.getState().setEngineSessionId(resolvedEngineSessionId);
          setActiveSession(session.id, resolvedEngineSessionId);
        }

        // Apply messages
        const stored = data.messages ?? [];
        if (stored.length > 0) {
          const msgs = filterLivePendingSteerRows(session.id, stored.map((m: any) => ({
            id: m.id, shortId: m.short_id || undefined, role: m.role,
            content: parseStoredMessageContent(m.content),
            timestamp: new Date(m.created_at).getTime(),
            updatedAt: m.updated_at ? new Date(m.updated_at).getTime() : undefined,
            completedAt: m.completed_at ? new Date(m.completed_at).getTime() : undefined,
            parentToolUseId: m.parent_tool_use_id,
            durationMs: m.duration_ms || undefined,
            inputTokens: m.input_tokens || undefined,
            outputTokens: m.output_tokens || undefined,
            reasoningTokens: m.metadata?.usage?.reasoning_tokens || undefined,
            contextWindowSize: m.metadata?.usage?.context_window_size || undefined,
            stopReason: m.stop_reason || undefined,
            metadata: m.metadata ?? null,
          })));
          cacheSessionMessages(session.id, msgs);
          useChatStore.getState().setMessages(msgs, { replayPresentFile: true });
          useChatStore.getState().setCost({ totalCost: 0, inputTokens: 0, outputTokens: 0, cumulativeInputTokens: 0, cumulativeOutputTokens: 0, turnCount: 0, ...deriveContextCostFromMessages(msgs, session) });
          useChatStore.getState().setHasMoreMessages(data.hasMore ?? false);
          useChatStore.getState().setOldestMessageId(data.oldestId ?? null);
          useChatStore.getState().setSessionLoading(false);
          clearTimeout(timeoutId);
          return;
        }
      }
    } catch (err) {
      // AbortError on timeout is expected — log differently for clarity.
      if ((err as any)?.name === 'AbortError') {
        console.warn('[app] handleSelectSession fetch timed out (10s) for session', session.id);
      } else {
        console.warn('[app] handleSelectSession load messages failed:', err);
      }
    } finally {
      clearTimeout(timeoutId);
      if (useSessionStore.getState().activeSessionId === session.id && useChatStore.getState().sessionId === session.id) {
        useChatStore.getState().setSessionLoading(false);
      }
    }

    // No synthetic "Switched to session" bubble for empty sessions — keep the first screen clean.

  }, [setActiveSessionId, clearMessages, token, setActiveSession]);

  // Phase 1.2 + 2 (issue #11): back/forward navigation landed on a different
  // session than the store holds. `sessionKey` 는 short_code 또는 UUID — sessions
  // 목록에서 둘 다 매칭한다.
  const handlePopSession = useCallback((sessionKey: string | null) => {
    if (!sessionKey) {
      setActiveSessionId(null);
      return;
    }
    const found = findSessionByKey(useSessionStore.getState().sessions, sessionKey);
    if (found) handleSelectSession(found);
  }, [handleSelectSession, setActiveSessionId]);

  // Preserved `/r/<key>` links now land on retirement guidance. Existing room
  // data remains untouched, but the main app no longer opens the channel surface.
  const handlePopRoom = useCallback((roomKey: string | null) => {
    useRoomStore.getState().setActiveRoomId(null);
    if (roomKey) {
      useFileStore.getState().activateChatSlot();
      useSessionStore.getState().setActiveView('rooms');
      useSessionStore.getState().setSidebarOpen(false);
    }
  }, []);

  // Mirror store ↔ URL. Gated on sessionsLoaded so a `/s/<id>` deep link isn't
  // clobbered before it has been restored into the store.
  useUrlSync({ onPopSession: handlePopSession, onPopRoom: handlePopRoom }, sessionsLoaded);

  // Reconcile sidebar sessions after likely missed-event windows. WebSocket
  // events remain the fast path; these REST refetches cover background tabs,
  // reconnects, cross-device creation, and mobile app switching.
  useEffect(() => {
    if (!sessionsLoaded || !connected) return;
    void refreshSessionList('ws-connected');
  }, [connected, sessionsLoaded, refreshSessionList]);

  useEffect(() => {
    if (!sessionsLoaded) return;
    const refreshOnReturn = () => {
      if (document.visibilityState === 'visible') {
        void refreshSessionList('visibility', { minIntervalMs: 15000 });
      }
    };
    const refreshOnFocus = () => {
      void refreshSessionList('focus', { minIntervalMs: 15000 });
    };
    document.addEventListener('visibilitychange', refreshOnReturn);
    window.addEventListener('focus', refreshOnFocus);
    return () => {
      document.removeEventListener('visibilitychange', refreshOnReturn);
      window.removeEventListener('focus', refreshOnFocus);
    };
  }, [sessionsLoaded, refreshSessionList]);

  useEffect(() => {
    if (!sessionsLoaded || sidebarTab !== 'sessions') return;
    void refreshSessionList('sidebar-tab', { minIntervalMs: 15000 });
  }, [sidebarTab, sessionsLoaded, refreshSessionList]);


  // Load sessions when auth resolves
  useEffect(() => {
    if (authStatus === null) return; // Still loading auth
    if (authStatus.authEnabled && !token) return; // Need login first

    const startupKey = `${authStatus.authEnabled ? 'auth' : 'public'}:${token ?? 'anon'}`;
    if (sessionsLoaded && startupSessionsLoadRef.current.key === startupKey) return;
    if (startupSessionsLoadRef.current.inFlight && startupSessionsLoadRef.current.key === startupKey) return;
    startupSessionsLoadRef.current = { key: startupKey, inFlight: true };

    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const loadProjects = () => fetch(`${API_BASE}/projects`, { headers })
      .then((r) => r.ok ? r.json() : [])
      .then((data) => {
        const projects = Array.isArray(data) ? data : [];
        useProjectStore.getState().setProjects(projects);
        return projects;
      })
      .catch(() => []);
    const projectsPromise = loadProjects();
    const sessionsLoadStartedAt = perfNow();

    fetchWithRestartTolerantAuth(`${API_BASE}/sessions?limit=${STARTUP_SESSION_LIST_LIMIT}`, { headers })
      .then(async (r) => {
        const responseMs = Math.round(perfNow() - sessionsLoadStartedAt);
        if (r.status === 401) { localStorage.removeItem('token'); setToken(null); return []; }
        if (!r.ok) {
          logClientPerf('startup-sessions-fetch', { status: r.status, responseMs, elapsedMs: responseMs }, { thresholdMs: 500 });
          return [];
        }
        const parseStartedAt = perfNow();
        const data = await r.json();
        const parseMs = Math.round(perfNow() - parseStartedAt);
        logClientPerf('startup-sessions-fetch', {
          status: r.status,
          sessionCount: Array.isArray(data) ? data.length : 0,
          requestedLimit: STARTUP_SESSION_LIST_LIMIT,
          responseMs,
          parseMs,
          elapsedMs: Math.round(perfNow() - sessionsLoadStartedAt),
        }, { thresholdMs: 500 });
        return data;
      })
      .then(async (data) => {
        const setSessionsStartedAt = perfNow();
        resetProjectSessionHydration();
        setRecentSessions(data);
        sessionListRefreshRef.current.lastAt = Date.now();
        setSessionsLoaded(true);
        logClientPerf('startup-sessions-store-set', {
          sessionCount: Array.isArray(data) ? data.length : 0,
          requestedLimit: STARTUP_SESSION_LIST_LIMIT,
          setStateMs: Math.round(perfNow() - setSessionsStartedAt),
          elapsedMs: Math.round(perfNow() - sessionsLoadStartedAt),
        }, { thresholdMs: 500 });

        // Restore `?view=` and `?system=` before resolving the session, so a
        // deep-linked workspace tab (e.g. /s/<id>?system=publishing) lands on
        // the right main-screen panel after reload.
        const initialUrl = parseUrl(window.location.pathname, window.location.search);
        if (initialUrl.view) useSessionStore.getState().setActiveView(initialUrl.view);
        if (initialUrl.systemTab) useFileStore.getState().openSystemTab(initialUrl.systemTab);

        const restoreLastViewedSession = async () => {
          const lastId = localStorage.getItem(lastViewedKey(getTokenUserId(token)));
          if (!lastId) return false;
          const lastSession = data.find((s: SessionMeta) => s.id === lastId);
          if (lastSession) {
            await handleSelectSession(lastSession);
            return true;
          }
          try {
            const res = await fetch(`${API_BASE}/sessions/${lastId}`, { headers });
            if (!res.ok) return false;
            const session = await res.json();
            useSessionStore.getState().addSession(session);
            await handleSelectSession(session);
            return true;
          } catch {
            return false;
          }
        };

        // Preserved internal-channel links never reopen the retired surface.
        const { roomKey: targetRoomKey } = initialUrl;
        if (targetRoomKey) {
          useRoomStore.getState().setActiveRoomId(null);
          useFileStore.getState().activateChatSlot();
          useSessionStore.getState().setActiveView('rooms');
          useSessionStore.getState().setSidebarOpen(false);
          return;
        }

        // Deep link: /s/<key> — short_code(8자) 또는 UUID(36자, 옛 링크 호환).
        // Phase 1.2 + 2 (issue #11): URL 은 더 이상 지워지지 않음 — useUrlSync 가
        // active 세션의 short_code 로 자연 업그레이드.
        // Explicit deep links must never silently fall back to last-viewed. If
        // the key cannot be resolved, stay on the requested URL with an empty
        // chat state and show a concrete error instead of opening another
        // session. This prevents rare startup/reconnect races from landing the
        // user in an unrelated session.
        const { sessionKey: targetKey } = initialUrl;
        if (targetKey) {
          const handleUnresolvedDeepLink = () => {
            setActiveSessionId(null);
            useChatStore.getState().setSessionId(null);
            useChatStore.getState().setEngineSessionId(null);
            clearMessages();
            useChatStore.getState().setSessionLoading(false);
            toastError(t('layout:requestedSessionNotFound'));
          };

          // 로컬 sessions 에서 short_code/UUID 매칭 우선
          const found = findSessionByKey(data, targetKey);
          if (found) {
            await handleSelectSession(found);
            if (initialUrl.systemTab) useFileStore.getState().openSystemTab(initialUrl.systemTab);
            return;
          }
          // 로컬 목록에 없는 공유 세션도 서버에서 resolve한다. 백엔드의
          // GET /sessions/:id 는 UUID와 short_code를 모두 지원하므로, 공유받은
          // `/s/<short_code>` 링크가 수신자의 초기 세션 목록에 없더라도 접근 권한을
          // 확인한 뒤 바로 열 수 있어야 한다.
          try {
            const h: Record<string, string> = {};
            if (token) h['Authorization'] = `Bearer ${token}`;
            const res = await fetch(`${API_BASE}/sessions/${targetKey}`, { headers: h });
            if (res.ok) {
              const session = await res.json();
              await handleSelectSession(session);
              if (initialUrl.systemTab) useFileStore.getState().openSystemTab(initialUrl.systemTab);
            } else {
              handleUnresolvedDeepLink();
            }
          } catch {
            handleUnresolvedDeepLink();
          }
          return;
        }

        // Silently restore the last session the user was viewing.
        if (await restoreLastViewedSession()) return;

        // Agent-first onboarding is a true first-use fallback only. Existing
        // users are never redirected, and deep links were already handled.
        const projects = await projectsPromise;
        const decision = decideAgentFirstStartup({
          agentFirstEnabled: useSettingsStore.getState().serverConfig?.agentFirstEnabled === true,
          sessions: data,
          projects,
        });
        if (decision.kind === 'open-agent-creator') {
          // Register the creator event effect from this render before dispatching.
          window.setTimeout(() => window.dispatchEvent(new CustomEvent('tower-start-agent-academy')), 0);
        }
      })
      .catch(() => { setSessionsLoaded(true); })
      .finally(() => {
        if (startupSessionsLoadRef.current.key === startupKey) {
          startupSessionsLoadRef.current.inFlight = false;
        }
      });

    // Fetch spaces
    fetch(`${API_BASE}/spaces`, { headers })
      .then((r) => r.ok ? r.json() : [])
      .then((data) => { if (Array.isArray(data)) useSpaceStore.getState().setSpaces(data); })
      .catch(() => {});
  }, [token, authStatus, sessionsLoaded, setRecentSessions, resetProjectSessionHydration, handleSelectSession, createSessionInDb]);

  const handleDeleteSession = useCallback(async (id: string) => {
    // Sidebar X now means "hide" (reversible from History), not permanent delete.
    try {
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`${API_BASE}/sessions/${id}/hide`, { method: 'POST', headers });
      if (!res.ok) throw new Error(`hide failed: ${res.status}`);
      removeSession(id);
      // Clear any orphaned queue for the hidden session
      useChatStore.getState().clearSessionQueue(id);
      toastQuiet(t('layout:sessionHiddenRestoreFromHistory'));
    } catch (err) {
      console.warn('[app] handleDeleteSession failed:', err);
      toastError(t('layout:sessionHideFailed'));
    }
  }, [token, removeSession]);

  const handleFileClick = useCallback((rawPath: string, options?: { split?: 'right' | 'bottom'; target?: 'main' | 'viewer'; backgroundViewer?: boolean; name?: string }) => {
    const path = normalizeTowerFilePath(rawPath);
    const openInViewer = options?.target !== 'main';
    const backgroundViewer = options?.backgroundViewer === true;
    const isPdf = path.split(/[?#]/, 1)[0].toLowerCase().endsWith('.pdf');
    if (isPdf) {
      // Opening a native browser PDF iframe can briefly blur/focus the page.
      // If a new frontend build is waiting, the update coordinator may treat
      // that idle moment as safe and hard-reload the whole app. Mark the click
      // window so update checks defer instead of interrupting file open.
      (window as any).__towerPdfOpenInProgressUntil = Date.now() + 5000;
    }
    if (isDirectoryLikeTowerPath(path)) {
      const normalizedDir = path.replace(/\/+$/, '');
      // Use the same AI teammate Home → FilesWorkspace reveal flow as the
      // current "폴더에서 열기" action. The legacy branch expanded the old
      // left file sidebar, which is no longer the primary file workspace.
      window.dispatchEvent(new CustomEvent('tower-reveal-tab-target', {
        detail: { kind: 'file', path: normalizedDir },
      }));
      return;
    }

    if (getFileExt(path) === 'pdf') {
      if (backgroundViewer) {
        useFileStore.getState().openTab(path, '', 'pdf', 'utf-8', {
          forceNew: true,
          split: 'right',
          backgroundSplit: true,
          name: options?.name,
        });
      } else {
        openPdfInBrowserTab(path);
      }
      return;
    }

    // Tab system: if file already open in a tab, just focus it.
    // Do not change activeView here: top menu + sidebar are a navigation pair,
    // while body tabs are independent work targets.
    const fs = useFileStore.getState();
    if (!backgroundViewer) triggerArtifactFlash();
    if (openInViewer && !backgroundViewer) {
      if (useSessionStore.getState().isMobile) recordMobileDocumentRecent(path, options?.name);
      fs.setContextPanelOpen(true);
      fs.setActiveFilePane('extra');
      // Desktop exposes the extra pane directly. Mobile has no persistent
      // right pane, so make the fullscreen Viewer visible at click time. Doing
      // this before the fetch also keeps the WebSocket fallback observable.
      if (useSessionStore.getState().isMobile) {
        useSessionStore.getState().openMobileContext();
      }
    }
    const existingTab = fs.tabs.find(t => t.path === path);
    if (openInViewer) {
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      fetch(`${API_BASE}/files/read?path=${encodeURIComponent(path)}`, { headers })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || t('layout:fileLoadFailedWithStatus', { status: res.status }));
          useFileStore.getState().openTab(data.path || path, typeof data.content === 'string' ? data.content : '', data.language || 'text', data.encoding, {
            forceNew: backgroundViewer,
            split: 'right',
            backgroundSplit: backgroundViewer,
            name: options?.name,
          });
        })
        .catch((err) => {
          console.warn('[app] viewer file open failed, falling back to existing tab/websocket:', err);
          if (existingTab && !backgroundViewer) {
            fs.openSplitTab(existingTab.id, 'right');
          } else if (backgroundViewer) {
            fs.openTab(path, '', 'text', 'utf-8', {
              forceNew: true,
              split: 'right',
              backgroundSplit: true,
              name: options?.name,
            });
          } else {
            requestFile(path);
          }
        });
    } else if (existingTab) {
      fs.setActiveTab(existingTab.id);
    } else {
      requestFile(path);
    }
    // v2 (2026-05-22): no longer force-switch the sidebar to 'files' view —
    // the file opens in the main body tab bar regardless of which sidebar
    // tab the user is on. Keeps sidebar context (sessions / files / pins)
    // where the user left it.
    // See: workspace/decisions/2026-05-22-global-multi-tab-shell.md
  }, [requestFile, requestFileTree, token, triggerArtifactFlash]);

  // Personal content uses the same right-side Viewer contract as project files.
  // Mobile has no persistent right pane, so opening a Viewer tab must also reveal
  // the fullscreen context overlay.
  const revealPersonalViewer = useCallback(() => {
    if (useSessionStore.getState().isMobile) {
      useSessionStore.getState().openMobileContext();
    }
  }, []);

  // File clicks default to the right-side Viewer Pane so chat/work context stays
  // in the main pane. Keep this as a stable callback instead of inline lambdas so the
  // virtualized chat body does not churn handlers/remount clickable content.
  const openPersonalFileInViewer = useCallback(async (uri: string) => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const listRes = await fetch(`${API_BASE}/personal-space/files`, { headers });
    const listed = await listRes.json().catch(() => ({}));
    const metadata = Array.isArray(listed.files) ? listed.files.find((file: any) => file.uri === uri) : null;
    if (metadata?.kind === 'file') {
      const contentUrl = `${API_BASE}/personal-space/files/content?uri=${encodeURIComponent(uri)}`;
      const store = useFileStore.getState();
      store.openTab(contentUrl, '', 'url', 'utf-8', { forceNew: true, split: 'right', name: metadata.name || t('viewMyFiles') });
      revealPersonalViewer();
      recordRecentPersonalDocument(uri);
      void recordServerPersonalDocumentOpened(uri).catch(() => {});
      triggerArtifactFlash();
      return;
    }
    const res = await fetch(`${API_BASE}/personal-space/files/read?uri=${encodeURIComponent(uri)}`, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('layout:personalNoteLoadFailedWithStatus', { status: res.status }));
    const resolvedUri = data.uri || uri;
    if (Number.isInteger(data.version)) personalFileVersionsRef.current.set(resolvedUri, data.version);
    const store = useFileStore.getState();
    store.openTab(resolvedUri, typeof data.content === 'string' ? data.content : '', 'markdown', 'utf-8', {
      forceNew: true,
      split: 'right',
      name: data.name || t('personalNoteTitleAndFilename'),
    });
    revealPersonalViewer();
    recordRecentPersonalDocument(resolvedUri);
    void recordServerPersonalDocumentOpened(resolvedUri).catch(() => {});
    triggerArtifactFlash();
  }, [token, triggerArtifactFlash, revealPersonalViewer]);

  const openPersonalMaterialsInViewer = useCallback(() => {
    const store = useFileStore.getState();
    const mobile = useSessionStore.getState().isMobile;
    store.openTab(mobile ? 'personal://documents' : 'personal://materials', '', mobile ? 'personal-documents' : 'personal-materials', 'utf-8', {
      forceNew: true,
      split: 'right',
      name: mobile ? t('myDocuments') : t('myMaterials'),
    });
    revealPersonalViewer();
    triggerArtifactFlash();
  }, [triggerArtifactFlash, revealPersonalViewer]);

  const openPersonalTodosInViewer = useCallback(() => {
    const store = useFileStore.getState();
    store.openTab('personal://todos', '', 'personal-todos', 'utf-8', {
      forceNew: true,
      split: 'right',
      name: t('myTodo'),
    });
    revealPersonalViewer();
    triggerArtifactFlash();
  }, [triggerArtifactFlash, revealPersonalViewer]);

  const openPersonalArchiveInViewer = useCallback(() => {
    const store = useFileStore.getState();
    store.openTab('personal://archive', '', 'personal-archive', 'utf-8', {
      forceNew: true,
      split: 'right',
      name: t('layout:archive'),
    });
    revealPersonalViewer();
    triggerArtifactFlash();
  }, [triggerArtifactFlash, revealPersonalViewer]);

  const handleReloadFile = useCallback((path: string) => {
    if (path.startsWith('personal://')) {
      void openPersonalFileInViewer(path).catch((error) => {
        toastError(error instanceof Error ? error.message : t('layout:personalNoteReloadFailed'));
      });
      return;
    }
    requestFile(path);
  }, [openPersonalFileInViewer, requestFile]);

  const handleRenamePersonalFile = useCallback(async (uri: string, title: string) => {
    const relativePath = uri.slice('personal://'.length);
    const slash = relativePath.lastIndexOf('/');
    const parent = slash >= 0 ? relativePath.slice(0, slash + 1) : '';
    const nextPath = `${parent}${title}.md`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/personal-space/files/rename`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ uri, nextPath }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data.error || t('layout:personalNoteRenameFailedWithStatus', { status: res.status });
      toastError(message);
      throw new Error(message);
    }
    const nextUri = data.uri || `personal://${nextPath}`;
    const previousVersion = personalFileVersionsRef.current.get(uri);
    personalFileVersionsRef.current.delete(uri);
    if (Number.isInteger(data.version)) personalFileVersionsRef.current.set(nextUri, data.version);
    else if (previousVersion != null) personalFileVersionsRef.current.set(nextUri, previousVersion + 1);
    useFileStore.getState().renameOpenTabPath(uri, nextUri, data.name || `${title}.md`);
    toastSuccess(t('layout:personalNoteRenamed'));
  }, [token]);

  const handleCreatePersonalNote = useCallback(async () => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`${API_BASE}/personal-space/files/create-note`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: '' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('layout:personalNoteCreateFailedWithStatus', { status: res.status }));
      await openPersonalFileInViewer(data.uri);
      useFileStore.getState().setContextPanelTab('write');
      toastSuccess(t('layout:blankPersonalNoteOpened'));
    } catch (error) {
      toastError(error instanceof Error ? error.message : t('layout:personalNoteCreateFailed'));
    }
  }, [openPersonalFileInViewer, token]);

  const handleMessageFileClick = useCallback((path: string) => {
    if (sessionAttachmentIdFromUri(path)) {
      const sessionId = useChatStore.getState().sessionId || useSessionStore.getState().activeSessionId || '';
      const token = localStorage.getItem('token');
      const contentUrl = sessionAttachmentContentUrl(sessionId, path, token);
      if (!contentUrl) {
        toastError(t('layout:attachmentSessionNotFound'));
        return;
      }
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      const metadataUrl = contentUrl.replace(/\/content(?=\?|$)/, '');
      fetch(metadataUrl, { headers })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || t('layout:attachmentLoadFailedWithStatus', { status: res.status }));
          const attachment = data.attachment || {};
          const mimeType = String(attachment.mimeType || '');
          const language = mimeType.startsWith('image/') ? 'image' : 'text';
          useFileStore.getState().setContextPanelOpen(true);
          useFileStore.getState().setActiveFilePane('extra');
          useFileStore.getState().openTab(contentUrl, '', language, 'utf-8', {
            split: 'right',
            name: attachment.name || t('layout:attachment'),
          });
          if (useSessionStore.getState().isMobile) useSessionStore.getState().openMobileContext();
        })
        .catch((error) => toastError(error instanceof Error ? error.message : t('layout:attachmentOpenFailed')));
      return;
    }
    handleFileClick(path, { split: 'right' });
  }, [handleFileClick]);

  const presentViewerDelivery = useCallback((delivery: SessionViewerDelivery, alreadyConsumed = false) => {
    if (!alreadyConsumed && hasConsumedSessionViewerDelivery(delivery.deliveryId)) return;
    if (!alreadyConsumed) markSessionViewerDeliveryConsumed(delivery.deliveryId);
    handleFileClick(delivery.path, {
      split: 'right',
      target: 'viewer',
      backgroundViewer: !delivery.focus,
      name: delivery.label,
    });
  }, [handleFileClick]);

  useEffect(() => {
    const presentFileHandler = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; deliveryId?: string; path?: string; label?: string; focus?: boolean }>).detail;
      if (!detail?.path || !detail.sessionId) return;
      const delivery: SessionViewerDelivery = {
        deliveryId: detail.deliveryId || `${detail.sessionId}:${detail.path}`,
        sessionId: detail.sessionId,
        path: detail.path,
        label: detail.label,
        focus: detail.focus !== false,
      };
      if (delivery.sessionId !== useSessionStore.getState().activeSessionId) {
        queueSessionViewerDelivery(delivery);
        return;
      }
      presentViewerDelivery(delivery);
    };
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; split?: 'right' | 'bottom' }>).detail;
      const path = detail?.path;
      if (!path) return;
      if (path === 'personal://todos') {
        openPersonalTodosInViewer();
        return;
      }
      if (path === 'personal://materials' || path === 'personal://documents') {
        if (path === 'personal://materials' && useSessionStore.getState().isMobile) {
          const store = useFileStore.getState();
          store.openTab('personal://materials', '', 'personal-materials', 'utf-8', { forceNew: true, split: 'right', name: t('myMaterials') });
          revealPersonalViewer();
          return;
        }
        openPersonalMaterialsInViewer();
        return;
      }
      if (path === 'personal://archive') {
        openPersonalArchiveInViewer();
        return;
      }
      if (path.startsWith('personal://')) {
        void openPersonalFileInViewer(path).catch((error) => {
          toastError(error instanceof Error ? error.message : t('layout:personalFileOpenFailed'));
        });
        return;
      }
      handleFileClick(path, detail?.split ? { split: 'right' } : undefined);
    };
    window.addEventListener('tower-present-file', presentFileHandler as EventListener);
    window.addEventListener('tower-open-path', handler as EventListener);
    return () => {
      window.removeEventListener('tower-present-file', presentFileHandler as EventListener);
      window.removeEventListener('tower-open-path', handler as EventListener);
    };
  }, [handleFileClick, openPersonalArchiveInViewer, openPersonalFileInViewer, openPersonalMaterialsInViewer, openPersonalTodosInViewer, presentViewerDelivery, revealPersonalViewer]);

  useEffect(() => {
    if (!activeSessionId) return;
    const pending = consumeSessionViewerDelivery(activeSessionId);
    if (pending) presentViewerDelivery(pending, true);
  }, [activeSessionId, presentViewerDelivery]);

  const handleDirectoryClick = useCallback((dirPath: string) => {
    const fileStore = useFileStore.getState();
    const entry = findEntry(fileStore.tree, dirPath);
    if (entry && entry.isExpanded) {
      // Collapse
      fileStore.toggleDirectory(dirPath);
    } else {
      // Expand: set loading, fetch children, then set them
      fileStore.setDirectoryLoading(dirPath, true);
      fileStore.toggleDirectory(dirPath);
      requestFileTree(dirPath);
    }
  }, [requestFileTree]);

  const handleRenameSession = useCallback(async (id: string, name: string) => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      await fetch(`${API_BASE}/sessions/${id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ name, autoNamed: 0 }),
      });
      useSessionStore.getState().updateSessionMeta(id, { name, autoNamed: 0 });
    } catch (err) { console.warn('[app] handleRenameSession failed:', err); }
  }, [token]);

  const handleToggleFavorite = useCallback(async (id: string, favorite: boolean) => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      await fetch(`${API_BASE}/sessions/${id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ favorite }),
      });
      useSessionStore.getState().updateSessionMeta(id, { favorite });
    } catch (err) { console.warn('[app] handleToggleFavorite failed:', err); }
  }, [token]);

  // Auto-create session on first message if no active session
  const creatingSession = useRef(false);
  const personalFileVersionsRef = useRef(new Map<string, number>());
  const replayBranchPromptKeysRef = useRef(new Set<string>());
  const handleSendMessage = useCallback(async (message: string, cwdOrOptions?: string | SendOptions, maybeOptions?: SendOptions) => {
    const cwd = typeof cwdOrOptions === 'string' ? cwdOrOptions : undefined;
    const sendOptions = typeof cwdOrOptions === 'string' ? maybeOptions : cwdOrOptions;
    // v2 (2026-05-22): if a file tab is currently active in the main body,
    // auto-switch to the chat slot before sending — message destination is
    // always the active session's chat. Avoids message-into-the-void confusion.
    // See: workspace/decisions/2026-05-22-global-multi-tab-shell.md
    if (useFileStore.getState().activeTabId !== null) {
      useFileStore.getState().activateChatSlot();
    }
    const currentActiveId = useSessionStore.getState().activeSessionId;
    if (!currentActiveId) {
      // Prevent concurrent session creation (e.g., rapid double-send)
      if (creatingSession.current) return;
      creatingSession.current = true;
      try {
        const session = await createSessionInDb();
        if (session) {
          setActiveSessionId(session.id);
          useChatStore.getState().setSessionId(session.id);
          useFileStore.getState().openChatTab(session.id);
        }
      } finally {
        creatingSession.current = false;
      }
    }

    // sendMessage has its own sessionId guard with desync recovery
    const activeSess = useSessionStore.getState().sessions.find(
      (s) => s.id === useSessionStore.getState().activeSessionId
    );
    sendMessage(message, { ...(sendOptions || {}), cwd: cwd || activeSess?.cwd });
  }, [sendMessage, createSessionInDb, setActiveSessionId]);

  useEffect(() => {
    const pendingTimers = new Set<number>();
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string; prompt?: string; cwd?: string }>).detail ?? {};
      const sessionId = detail.sessionId;
      const prompt = detail.prompt?.trim();
      if (!sessionId || !prompt) return;
      const replayKey = `${sessionId}:${prompt}`;
      if (replayBranchPromptKeysRef.current.has(replayKey)) return;

      let attempts = 0;
      const tryReplay = () => {
        attempts += 1;
        // The branch action selects the child first, but loading the child can
        // lag behind the event. Wait briefly instead of dropping the modified
        // prompt, while still refusing to send into any other active session.
        if (useSessionStore.getState().activeSessionId === sessionId && useChatStore.getState().sessionId === sessionId) {
          replayBranchPromptKeysRef.current.add(replayKey);
          sendMessage(prompt, { cwd: detail.cwd, suppressUserEcho: false });
          return;
        }
        if (attempts >= 40) return;
        const timer = window.setTimeout(() => {
          pendingTimers.delete(timer);
          tryReplay();
        }, 100);
        pendingTimers.add(timer);
      };
      tryReplay();
    };
    window.addEventListener('tower-replay-branch-prompt', handler);
    return () => {
      window.removeEventListener('tower-replay-branch-prompt', handler);
      for (const timer of pendingTimers) window.clearTimeout(timer);
      pendingTimers.clear();
    };
  }, [sendMessage]);

  useEffect(() => {
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent<{ projectId?: string | null; prompt?: string; sessionName?: string; label?: string | null }>).detail ?? {};
      // Leave projectId undefined when the caller did not choose one.
      // createSessionInDb then uses Tower's normal default: active session project,
      // then most-recent project session. Schedule creation UI may still pass General
      // explicitly when it wants a no-project schedule to land there.
      const projectId = detail.projectId || undefined;
      const prompt = detail.prompt?.trim();
      if (!prompt) return;

      const session = await createSessionInDb(detail.sessionName, projectId, detail.label === null ? undefined : (detail.label || undefined));
      if (!session) return;
      setActiveSessionId(session.id);
      useChatStore.getState().setSessionId(session.id);
      useChatStore.getState().setEngineSessionId(null);
      clearMessages();
      setActiveSession(session.id);
      useFileStore.getState().openChatTab(session.id);
      useSessionStore.getState().setActiveView('chat');
      useSessionStore.getState().setSidebarTab('sessions');
      useSessionStore.getState().setSidebarOpen(true);
      window.setTimeout(() => sendMessage(prompt, session.cwd), 250);
    };
    window.addEventListener('tower-start-prompt-session', handler);
    window.addEventListener('tower-start-schedule-wizard', handler);
    return () => {
      window.removeEventListener('tower-start-prompt-session', handler);
      window.removeEventListener('tower-start-schedule-wizard', handler);
    };
  }, [createSessionInDb, setActiveSessionId, clearMessages, setActiveSession, sendMessage]);

  const openAgentAcademy = useCallback(() => {
    const draft = buildInitialAgentAcademyDraft();
    const projectState = useProjectStore.getState();
    const sessionState = useSessionStore.getState();
    const activeProjectId = sessionState.sessions.find((session) => session.id === sessionState.activeSessionId)?.projectId;
    const sourceProject = projectState.projects.find((project) => project.id === activeProjectId && !project.archived)
      || projectState.projects.find((project) => !project.archived && project.systemKey !== 'ai-talent-team');
    // Any accessible active Project can carry the server-side approval intent.
    // The legacy AI Talent Team seed Project is not required for teammate creation.
    draft.sourceProjectId = sourceProject?.id;
    useAgentDraftStore.getState().setDraft(draft);
    const mobileHiring = sessionState.isMobile;
    useFileStore.getState().openTab(
      'agent-drafts/new-agent.agent-draft.json',
      JSON.stringify(draft, null, 2),
      'agent-draft',
      undefined,
      { split: 'right', name: t('newAiTeammate') },
    );
    // The creator is a file-backed workflow. Leave the Team Home workspace so
    // its activeView branch cannot keep rendering over the newly opened draft.
    sessionState.setActiveView('chat');
    if (mobileHiring) sessionState.openMobileContext(false);
  }, [t]);

  useEffect(() => {
    window.addEventListener('tower-start-agent-academy', openAgentAcademy);
    return () => window.removeEventListener('tower-start-agent-academy', openAgentAcademy);
  }, [openAgentAcademy]);

  useEffect(() => {
    const handler = () => {
      useSessionStore.getState().setActiveView('chat');
      useSessionStore.getState().setSidebarOpen(true);
      void sendMessage('기본 캐릭터 목록에서 원하는 인상을 찾지 못했어요. 같은 Tower 캐릭터 구조를 유지하면서 새 캐릭터를 만들어 주세요. 색감, 인상, 헤어스타일, 소품을 한 번에 하나씩 물어봐 주세요.', { suppressUserEcho: false });
    };
    window.addEventListener('tower-request-custom-agent-character', handler);
    return () => window.removeEventListener('tower-request-custom-agent-character', handler);
  }, [sendMessage]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ command?: string }>).detail ?? {};
      const command = detail.command?.trim();
      if (!command) return;
      useSessionStore.getState().setActiveView('chat');
      useFileStore.getState().activateChatSlot();
      handleSendMessage(command);
    };
    window.addEventListener('tower-run-agent-command', handler);
    return () => window.removeEventListener('tower-run-agent-command', handler);
  }, [handleSendMessage]);

  // Onboarding: explicit guide/tour only + What's New (버전 업데이트)
  const userId = token ? localStorage.getItem('userId') : null;
  const { showWhatsNew, dismissWhatsNew } = useOnboarding({
    token,
    userId,
    sessionsLoaded,
  });

  useEffect(() => {
    if (!token || !userId || !sessionsLoaded || firstRunInferenceSetup || hasSeenTowerGuide(userId)) return;
    const timer = window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('tower-start-tour', { detail: { tourId: 'beginner' } }));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [firstRunInferenceSetup, sessionsLoaded, token, userId]);

  // v3 (path B): activate a chat tab by sessionId. Looks up the SessionMeta and
  // routes through handleSelectSession (which loads messages + ensures the tab).
  const handleSelectChatSession = useCallback((sessionId: string) => {
    const sess = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
    if (sess) {
      handleSelectSession(sess, { preserveNavigation: true });
    } else {
      // Session metadata not loaded yet — still activate the body chat tab.
      // Preserve top menu + sidebar when this came from a main-tab click.
      useFileStore.getState().openChatTab(sessionId);
      setActiveSessionId(sessionId);
      useChatStore.getState().setSessionId(sessionId);
    }
  }, [handleSelectSession, setActiveSessionId]);

  const handleSaveFile = useCallback((path: string, content: string) => {
    // If path starts with prompt:, update prompt store
    if (path.startsWith('prompt:')) {
      const title = path.slice('prompt:'.length);
      const prompts = usePromptStore.getState().prompts;
      const match = prompts.find((p) => p.title === title);
      if (match && typeof match.id === 'number') {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        fetch(`${API_BASE}/prompts/${match.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ title: match.title, content }),
        }).then(() => {
          usePromptStore.getState().updatePrompt(match.id, { content });
          useFileStore.getState().setOpenFile({
            path, content, language: 'markdown', modified: false,
          });
          toastSuccess('Prompt saved');
        }).catch(() => toastError('Failed to save prompt'));
      }
      return;
    }
    if (path.startsWith('personal://')) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      fetch(`${API_BASE}/personal-space/files/write`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ uri: path, content, expectedVersion: personalFileVersionsRef.current.get(path) }),
      }).then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || t('layout:personalNoteSaveFailedWithStatus', { status: res.status }));
        if (Number.isInteger(data.version)) personalFileVersionsRef.current.set(path, data.version);
        useFileStore.getState().markTabSavedByPath(path);
        toastSuccess(t('layout:personalNoteSaved'));
      }).catch((error) => toastError(error instanceof Error ? error.message : t('layout:personalNoteSaveFailed')));
      return;
    }
    saveFile(path, content);
  }, [saveFile, token]);

  // ───── Pin handlers ─────
  const handlePinFile = useCallback(async (filePath: string, kind: 'file' | 'folder' = 'file') => {
    try {
      const existing = usePinStore.getState().pins.find((pin) => pin.file_path === filePath);
      if (existing) {
        toastQuiet(t('layout:alreadyInFavorites'));
        return;
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const name = filePath.split('/').pop() || filePath;
      const ext = kind === 'folder' ? '' : (filePath.split('.').pop()?.toLowerCase() || '');
      const typeMap: Record<string, string> = {
        md: 'markdown', html: 'html', htm: 'html', txt: 'text',
        py: 'python', ts: 'typescript', tsx: 'typescript',
        js: 'javascript', jsx: 'javascript', json: 'json',
      };
      const res = await fetch(`${API_BASE}/pins`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: name, filePath, fileType: kind === 'folder' ? 'folder' : (typeMap[ext] || 'text') }),
      });
      if (res.ok) {
        const pin = await res.json();
        usePinStore.getState().addPin(pin);
        toastQuiet(t('layout:addedToFavorites', { name }));
      }
    } catch (err) { console.warn('[app] handlePinFile failed:', err); }
  }, [token]);

  const handleUnpinFile = useCallback(async (id: number) => {
    try {
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      await fetch(`${API_BASE}/pins/${id}`, { method: 'DELETE', headers });
      usePinStore.getState().removePin(id);
      toastQuiet(t('layout:removedFromFavorites'));
    } catch (err) { console.warn('[app] handleUnpinFile failed:', err); }
  }, [token]);

  const handlePinClick = useCallback(async (pin: Pin) => {
    if (pin.file_type === 'folder') {
      requestFileTree(pin.file_path);
      useSessionStore.getState().setActiveView('chat');
      useSessionStore.getState().setSidebarTab('files');
      useSessionStore.getState().setSidebarOpen(true);
      return;
    }
    // Use HTTP API directly instead of WebSocket — more reliable
    // (WS send silently drops messages when connection is unstable)
    try {
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`${API_BASE}/files/read?path=${encodeURIComponent(pin.file_path)}`, { headers });
      if (!res.ok) {
        // Fallback to WebSocket if HTTP fails
        requestFile(pin.file_path);
        useFileStore.getState().setContextPanelTab('preview');
        return;
      }
      const data = await res.json();
      useFileStore.getState().setContextPanelTab('preview');
      useFileStore.getState().setOpenFile({
        path: data.path,
        content: data.content,
        language: data.language,
        modified: false,
        ...(data.encoding && { encoding: data.encoding }),
      });
      if (useSessionStore.getState().isMobile) {
        useSessionStore.getState().openMobileContext();
      }
    } catch {
      // Fallback to WebSocket
      useFileStore.getState().setContextPanelTab('preview');
      requestFile(pin.file_path);
    }
  }, [token, requestFile, requestFileTree]);

  // ───── Prompt handlers ─────
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<PromptItem | null>(null);

  const handlePromptClick = useCallback((prompt: PromptItem) => {
    // Show prompt content in ContextPanel
    useFileStore.getState().setContextPanelTab('preview');
    useFileStore.getState().setOpenFile({
      path: `prompt:${prompt.title}`,
      content: prompt.content || '(no content)',
      language: 'markdown',
      modified: false,
    });
  }, []);

  const handlePromptAdd = useCallback(() => {
    setEditingPrompt(null);
    setPromptEditorOpen(true);
  }, []);

  const handlePromptEdit = useCallback((prompt: PromptItem) => {
    setEditingPrompt(prompt);
    setPromptEditorOpen(true);
  }, []);

  const handlePromptSave = useCallback(async (title: string, content: string) => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      if (editingPrompt && typeof editingPrompt.id === 'number') {
        await fetch(`${API_BASE}/prompts/${editingPrompt.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ title, content }),
        });
        usePromptStore.getState().updatePrompt(editingPrompt.id, { title, content });
      } else {
        const res = await fetch(`${API_BASE}/prompts`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ title, content }),
        });
        if (res.ok) {
          const pin = await res.json();
          usePromptStore.getState().addPrompt({
            id: pin.id,
            title: pin.title,
            content: pin.content || '',
            source: 'user',
            readonly: false,
          });
        }
      }
    } catch (err) { console.warn('[app] handlePromptSave failed:', err); }
    setEditingPrompt(null);
  }, [token, editingPrompt]);

  const handlePromptDelete = useCallback(async (id: number | string) => {
    if (typeof id !== 'number') return; // Can't delete command-sourced prompts
    try {
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      await fetch(`${API_BASE}/prompts/${id}`, { method: 'DELETE', headers });
      usePromptStore.getState().removePrompt(id);
    } catch (err) { console.warn('[app] handlePromptDelete failed:', err); }
  }, [token]);

  // ───── Git handlers ─────
  const handleViewDiff = useCallback((diff: string) => {
    useFileStore.getState().setContextPanelTab('preview');
    useFileStore.getState().setOpenFile({
      path: 'diff:git',
      content: diff,
      language: 'diff',
      modified: false,
    });
  }, []);

  // ───── Settings handlers ─────
  const handleOpenSettings = useCallback(() => {
    useSettingsStore.getState().setOpen(true);
  }, []);

  const [adminOpen, setAdminOpen] = useState(false);
  const [personalCredentialsOpen, setPersonalCredentialsOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const tokenPayload = useMemo(() => {
    try {
      const t = localStorage.getItem('token');
      if (!t) return null;
      return JSON.parse(atob(t.split('.')[1]));
    } catch { return null; }
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  // 2026-05-04: AdminPanel 진입은 admin/operator. 탭별 가시성은 AdminPanel 내부에서.
  // 2026-07-01: 개인 Credential은 AdminPanel이 아닌 별도 '개인 크레덴셜' 메뉴로 분리.
  // 2026-05-22: localStorage('userRole') 의존 제거 — JWT payload 가 단일 source of truth.
  //   기존엔 login 응답에서 setItem 한 'userRole' 이 비거나 stale 일 때 admin 메뉴가
  //   사라지는 버그가 있었음 (cookie/SSO 진입처럼 login response 안 거치는 케이스 포함).
  //   tokenPayload.role 은 verifyToken 으로 backend 가 검증하는 값이라 신뢰 가능.
  const canOpenAdminPanel = tokenPayload?.role === 'admin' || tokenPayload?.role === 'operator';
  const canOpenPersonalCredentials = !!tokenPayload?.role;
  const handleOpenAdmin = useCallback(() => setAdminOpen(true), []);
  const handleOpenPersonalCredentials = useCallback(() => setPersonalCredentialsOpen(true), []);

  const handleLogout = useCallback(() => {
    localStorage.removeItem('token');
    // 'userRole' 키는 더 이상 쓰지 않지만, 구버전이 남겨둔 stale 값이 있을 수 있으니
    // 로그아웃 시 한 번 청소해두자 (다음 로그인 사용자가 영향받지 않도록).
    localStorage.removeItem('userRole');
    document.cookie = 'tower_token=; path=/; max-age=0';
    void fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' }).catch(() => {});
    setToken(null);
  }, []);

  // Navigate to a session from cross-cutting surfaces (Kanban, History,
  // Automation, and in-chat Tower `/s/<key>` links). `sessionKey` may be a
  // shortCode or UUID; `sessionId` is kept for older callers. `forceNew` opens
  // a new Tower chat tab before selection, preserving the current tab.
  useEffect(() => {
    const handler = async (e: Event) => {
      const { sessionId, sessionKey, forceNew, hash } = (e as CustomEvent).detail ?? {};
      const key = sessionKey || sessionId;
      if (!key) return;
      let session = sessionKey
        ? findSessionByKey(useSessionStore.getState().sessions, sessionKey)
        : useSessionStore.getState().sessions.find((s) => s.id === sessionId);
      // Fallback: fetch from API if not in store (e.g. task session not yet added,
      // restored/hidden sidebar row, or a pasted shortCode URL). The backend accepts
      // both UUID and shortCode keys.
      if (!session) {
        try {
          const headers: Record<string, string> = {};
          const t = localStorage.getItem('token');
          if (t) headers['Authorization'] = `Bearer ${t}`;
          const res = await fetch(`${API_BASE}/sessions/${key}`, { headers });
          if (res.ok) {
            session = await res.json();
            if (session) addSession(session);
          }
        } catch {}
      }
      if (session) {
        if (forceNew) useFileStore.getState().openChatTab(session.id, { forceNew: true });
        await handleSelectSession(session);
        if (typeof hash === 'string' && hash.startsWith('#')) {
          const targetPath = `/s/${session.shortCode || session.id}`;
          window.history.replaceState(null, '', `${targetPath}${hash}`);
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        }
      }
    };
    window.addEventListener('kanban-select-session', handler);
    return () => window.removeEventListener('kanban-select-session', handler);
  }, [handleSelectSession, addSession]);

  const activeView = useSessionStore((s) => s.activeView);

  useEffect(() => {
    const openAIServiceHome = (event: Event) => {
      if (!useSettingsStore.getState().serverConfig?.aiServicesEnabled) return;
      const projectId = (event as CustomEvent<{ projectId?: string }>).detail?.projectId;
      if (projectId) sessionStorage.setItem('tower-ai-service-create-project-id', projectId);
      useSessionStore.getState().setActiveView('aiServices');
      useSessionStore.getState().setSidebarOpen(false);
    };
    window.addEventListener('tower-open-ai-services', openAIServiceHome);
    return () => window.removeEventListener('tower-open-ai-services', openAIServiceHome);
  }, []);

  useEffect(() => {
    if (!aiServicesEnabled && activeView === 'aiServices') {
      useSessionStore.getState().setActiveView('chat');
    }
  }, [activeView, aiServicesEnabled]);

  useEffect(() => {
    if (activeView === 'kanban') {
      useSessionStore.getState().setActiveView('schedules');
      setSidebarOpen(false);
      return;
    }
    if (activeView === 'schedules') {
      setLastSidebarTab(useSessionStore.getState().sidebarTab);
      setSidebarOpen(false);
    }
  }, [activeView, setLastSidebarTab, setSidebarOpen]);

  // Global Ctrl+S handler (fallback when CodeMirror doesn't have focus)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        const fs = useFileStore.getState();
        if (fs.openFile && fs.openFile.modified) {
          handleSaveFile(fs.openFile.path, fs.openFile.content);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSaveFile]);

  // All update / reload decisions live in this single hook. App.tsx only
  // forwards its callbacks to OfflineBanner / UpdateBanner below, and hands
  // the /api/config payload to `evaluateConfigPayload` from the fetch effect.
  // Declared BEFORE the fetch effect so its dependency array can reference it
  // without a TDZ ReferenceError. See:
  // docs/arch_plan_0412_update_reload_coordinator.md
  const updateCoordinator = useAppUpdateCoordinator();
  const isBusyForReload = updateCoordinator.isBusyForReload;
  const handleReloadForUpdate = updateCoordinator.requestReload;
  const handleDeferUpdate = updateCoordinator.deferReload;
  const handleCancelDeferredUpdate = updateCoordinator.cancelDefer;

  // Load pins + server config on mount
  useEffect(() => {
    if (authStatus === null) return;
    if (authStatus.authEnabled && !token) return;

    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    fetch(`${API_BASE}/pins`, { headers })
      .then((r) => r.ok ? r.json() : [])
      .then((data) => usePinStore.getState().setPins(data))
      .catch(() => {});

    const promptParams = new URLSearchParams();
    const activeSession = useSessionStore.getState().sessions.find(
      (session) => session.id === useSessionStore.getState().activeSessionId,
    );
    if (activeSession?.projectId) promptParams.set('projectId', activeSession.projectId);
    if (activeSession?.cwd) promptParams.set('cwd', activeSession.cwd);
    fetch(`${API_BASE}/prompts${promptParams.toString() ? `?${promptParams.toString()}` : ''}`, { headers })
      .then((r) => r.ok ? r.json() : [])
      .then((data) => usePromptStore.getState().setPrompts(data))
      .catch(() => {});

    fetch(`${API_BASE}/git/log?limit=50`, { headers })
      .then((r) => r.ok ? r.json() : [])
      .then((data) => useGitStore.getState().setCommits(data))
      .catch(() => {});

    fetch(`${API_BASE}/config`, { headers })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data) return;

        // Hand build comparison to the coordinator. A healthy tab only gets
        // a non-blocking update banner; automatic reload is reserved for
        // broken chunk/bootstrap recovery.
        updateCoordinator.evaluateConfigPayload(data);

        useSettingsStore.getState().setServerConfig(data);
        if (data.models) useModelStore.getState().setAvailableModels(data.models);
        if (data.piModels) useModelStore.getState().setPiModels(data.piModels);
        if (data.localModels) useModelStore.getState().setLocalModels(data.localModels);
        if (data.connectionType) useModelStore.getState().setConnectionType(data.connectionType);
        if (data.defaults) useModelStore.getState().setDefaults(data.defaults);
        // Reconcile stale localStorage selectedModel with server registry
        reconcileSelectedModel();
      })
      .catch(() => {});
  }, [token, authStatus, updateCoordinator, activeSessionId]);

  useEffect(() => {
    clearReloadOnceFlag();
  }, []);

  // /file-viewer and /shared/:token are handled by <Routes> in main.tsx (Phase 1.1, issue #11)

  // Auth gate
  if (authStatus === null) {
    return (
      <div className="app-bg flex flex-col items-center justify-center min-h-full" style={{ minHeight: '100dvh' }}>
        <div className="text-primary-500 text-xl font-bold mb-2">Tower</div>
        <div className="text-gray-400 text-base">Loading...</div>
      </div>
    );
  }

  if (authStatus.authEnabled && !token) {
    return (
      <LoginPage
        isSetup={!authStatus.hasUsers}
        onLogin={handleLogin}
        onSignup={handleSignup}
        error={authError}
      />
    );
  }

  if (firstRunInferenceSetup && token) {
    return <FirstRunInferenceSetup token={token} onComplete={({ model, project, session }) => {
      localStorage.removeItem('tower:firstRunInferenceSetup');
      useModelStore.getState().setDefaults({ session: model, ai_reply: model, ai_task: model });
      useModelStore.getState().setSelectedModel(model);
      if (project?.id) useProjectStore.getState().addProject(project);
      if (session?.id) {
        useSessionStore.getState().addSession(session);
        useSessionStore.getState().setActiveSessionId(session.id);
        useChatStore.getState().setSessionId(session.id);
        useFileStore.getState().openChatTab(session.id);
      }
      setFirstRunInferenceSetup(false);
    }} />;
  }

  return (
    <div className="flex flex-col overflow-hidden app-bg text-gray-100 font-sans selection:bg-primary-500/30 selection:text-primary-100 h-full" style={{ height: 'var(--vvh, 100dvh)' }}>
      <Toaster position="top-right" theme={theme === 'light' ? 'light' : 'dark'} richColors closeButton />
      <OfflineBanner onReload={handleReloadForUpdate} />
      <UpdateBanner
        onReload={handleReloadForUpdate}
        onDeferReload={handleDeferUpdate}
        onCancelDeferred={handleCancelDeferredUpdate}
        busy={isBusyForReload}
      />
      {showWhatsNew && <WhatsNewModal onClose={dismissWhatsNew} />}
      <TourProvider>
      <SessionMessageCacheSync />
      <Header
        connected={connected}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => {
          if (sidebarOpen) {
            setLastSidebarTab(sidebarTab);
            setSidebarOpen(false);
          } else {
            setSidebarTab(lastSidebarTab);
            setSidebarOpen(true);
          }
        }}
        onNewSession={handleNewSession}
        onAdminClick={canOpenAdminPanel ? handleOpenAdmin : undefined}
        onPersonalCredentialsClick={canOpenPersonalCredentials ? handleOpenPersonalCredentials : undefined}
        onPublishClick={() => useFileStore.getState().openSystemTab('publishing')}
        onPersonalMaterialsClick={openPersonalMaterialsInViewer}
        onPersonalTodosClick={openPersonalTodosInViewer}
        onViewDiff={handleViewDiff}
        onLogout={handleLogout}
        onSettingsClick={handleOpenSettings}
        onPinsClick={() => {
          useSessionStore.getState().setActiveView('favorites');
          setSidebarOpen(false);
        }}
        onInboxClick={() => {
          useSessionStore.getState().setActiveView('inbox');
          setSidebarOpen(false);
        }}
        onHistoryClick={() => {
          if (!sidebarOpen) setSidebarOpen(true);
          setSidebarTab(sidebarTab === 'history' ? 'sessions' : 'history');
        }}
        onSessionFileClick={(path) => handleFileClick(path)}
        onRequestFileTree={() => requestFileTree()}
        onSelectSession={handleSelectSession}
        username={tokenPayload?.username}
        userRole={tokenPayload?.role}
      />

      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar — drawer on mobile */}
        {sidebarOpen && isMobile && (
          <div className="fixed inset-0 z-40" onClick={() => setSidebarOpen(false)}>
            <div className="absolute inset-0 bg-black/55 backdrop-blur-[1.5px]" />
            <div
              className="absolute left-0 top-12 bottom-0 animate-slide-in-left"
              style={{ width: sidebarTab === 'files' ? 'min(82vw, 340px)' : '85vw' }}
              onClick={(e) => e.stopPropagation()}
              data-tour-id="sidebar"
            >
              <Sidebar
                onNewSession={(projectId?: string, label?: string) => {
                  setSidebarOpen(false);
                  useSessionStore.getState().setActiveView('chat');
                  useSessionStore.getState().setMobileTab('ai');
                  void handleNewSession(projectId, label);
                }}
                onSelectSession={(s) => { handleSelectSession(s); setSidebarOpen(false); useSessionStore.getState().setMobileTab('ai'); }}
                onDeleteSession={handleDeleteSession}
                onRenameSession={handleRenameSession}
                onToggleFavorite={handleToggleFavorite}
                onFileClick={(p) => { handleFileClick(p); setSidebarOpen(false); }}
                onPersonalTodosClick={() => { openPersonalTodosInViewer(); setSidebarOpen(false); }}
                onPersonalFileClick={(uri) => {
                  void openPersonalFileInViewer(uri).then(() => setSidebarOpen(false)).catch((error) => {
                    toastError(error instanceof Error ? error.message : t('layout:personalFileOpenFailed'));
                  });
                }}
                onDirectoryClick={handleDirectoryClick}
                onRequestFileTree={(path) => requestFileTree(path)}
                onPinFile={handlePinFile}
                onUnpinFile={handleUnpinFile}
                onPinClick={(pin) => { handlePinClick(pin); setSidebarOpen(false); }}
                onSettingsClick={handleOpenSettings}
                onPromptClick={(prompt) => {
                  handlePromptClick(prompt);
                  useSessionStore.getState().openMobileContext();
                  setSidebarOpen(false);
                }}
                onPromptEdit={handlePromptEdit}
                onPromptDelete={handlePromptDelete}
                onPromptAdd={handlePromptAdd}
                onNewSessionInFolder={(path) => {
                  void handleNewSessionInFolder(path);
                  useSessionStore.getState().setActiveView('chat');
                  useSessionStore.getState().setMobileTab('ai');
                  setSidebarOpen(false);
                }}
                onCollapseSidebar={() => { setLastSidebarTab(sidebarTab); setSidebarOpen(false); }}
              />
            </div>
          </div>
        )}
        {sidebarOpen && !isMobile && activeView !== 'schedules' && (
          <>
            <div className="shrink-0" style={{ width: sidebarWidth }} data-tour-id="sidebar">
              <Sidebar
                onNewSession={handleNewSession}
                onSelectSession={handleSelectSession}
                onDeleteSession={handleDeleteSession}
                onRenameSession={handleRenameSession}
                onToggleFavorite={handleToggleFavorite}
                onFileClick={handleFileClick}
                onPersonalTodosClick={openPersonalTodosInViewer}
                onPersonalFileClick={(uri) => {
                  void openPersonalFileInViewer(uri).catch((error) => {
                    toastError(error instanceof Error ? error.message : t('layout:personalFileOpenFailed'));
                  });
                }}
                onDirectoryClick={handleDirectoryClick}
                onRequestFileTree={(path) => requestFileTree(path)}
                onPinFile={handlePinFile}
                onUnpinFile={handleUnpinFile}
                onPinClick={handlePinClick}
                onSettingsClick={handleOpenSettings}
                onPromptClick={handlePromptClick}
                onPromptEdit={handlePromptEdit}
                onPromptDelete={handlePromptDelete}
                onPromptAdd={handlePromptAdd}
                onCollapseSidebar={() => { setLastSidebarTab(sidebarTab); setSidebarOpen(false); }}
              />
            </div>
            <SidebarResizeHandle onResize={handleSidebarResize} />
          </>
        )}
        {/* When sidebar is collapsed, show a small expand button */}
        {!sidebarOpen && !isMobile && activeView !== 'schedules' && (
          <button
            onClick={() => { setSidebarTab(lastSidebarTab); setSidebarOpen(true); }}
            className="shrink-0 px-1 h-full flex items-center justify-center text-surface-700 hover:text-gray-400 hover:bg-surface-800/50 transition-colors"
            title={t('layout:showSidebar')}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}

        {/* Mobile documents use a true fullscreen surface. Keeping the app header
            and bottom navigation visible squeezed the document into a desktop-like
            pane and made reading/editing feel cramped. The document supplies its own
            back control and safe-area padding. */}
        {isMobile && mobileContextOpen && (
          <div className="fixed inset-0 z-[100] flex flex-col bg-surface-950">
            <div className="flex-1 min-h-0 overflow-hidden">
              <ErrorBoundary fallbackLabel="Context panel error">
                <ContextPanel
                  tabId={splitTabId ?? undefined}
                  onSave={handleSaveFile}
                  onReload={handleReloadFile}
                  onRenamePersonalFile={handleRenamePersonalFile}
                  onFileNavigate={requestFile}
                  hideTabBar
                  onMobileClose={() => {
                    useSessionStore.getState().closeMobileContext();
                  }}
                />
              </ErrorBoundary>
            </div>
          </div>
        )}

        {!isMobile ? (
          <>
            {/* Normal mode: main tab shell with optional right split preview. */}
            <main className="flex-1 min-w-0 flex justify-center">
              <div
                data-main-pane-dropzone="true"
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes('application/x-tower-file-tab')) e.preventDefault();
                }}
                onDrop={(e) => {
                  const tabId = e.dataTransfer.getData('application/x-tower-file-tab');
                  if (tabId && tabId === useFileStore.getState().splitTabId) {
                    e.preventDefault();
                    useFileStore.getState().returnSplitTabToMain();
                  }
                }}
                onMouseDown={() => setActiveFilePane('main')}
                className={`tower-main-shell relative overflow-hidden w-full flex flex-col h-full shadow-xl shadow-black/10 ${activeFilePane === 'main' ? 'ring-1 ring-primary-500/25' : 'ring-1 ring-transparent'} ${activeTabId === null && !activeSystemTabId && (activeView === 'chat' || activeView === 'projectFiles' || activeView === 'rooms') ? 'bg-surface-950/80 backdrop-blur-3xl' : 'bg-surface-950'}`}
              >
                {(activeTabId === null && !activeSystemTabId && (activeView === 'chat' || activeView === 'projectFiles' || activeView === 'rooms')) && (
                  <img src={appBackgroundSrc} alt="" aria-hidden="true" onError={() => { if (appBackgroundSrc !== towerBg) setAppBackgroundSrc(towerBg); }} className={`pointer-events-none select-none absolute inset-0 w-full h-full ${isCustomAppBackground ? 'object-contain opacity-[0.04]' : 'object-cover opacity-[0.12]'} z-0`} style={{ backgroundColor: isCustomAppBackground ? '#050505' : undefined, maskImage: 'radial-gradient(ellipse 90% 90% at 50% 50%, black 30%, transparent 75%)', WebkitMaskImage: 'radial-gradient(ellipse 90% 90% at 50% 50%, black 30%, transparent 75%)' }} />
                )}
                <ErrorBoundary fallbackLabel="Chat error">
                  {activeView === 'kanban' ? (
                    <KanbanBoard />
                  ) : activeView === 'schedules' && !activeSystemTabId ? (
                    <SchedulePanel />
                  ) : activeView === 'automations' ? (
                    <AutomationPanel />
                  ) : activeView === 'history' ? (
                    <HistoryPanel />
                  ) : activeView === 'inbox' ? (
                    <InboxPanel onSelectSession={handleSelectSession} />
                  ) : activeView === 'work' ? (
                    <ChallengeTimelinePanel />
                  ) : activeView === 'favorites' ? (
                    <FavoritesPanel
                      projects={projects}
                      onOpenPin={(pin) => pin.file_type === 'folder' ? void handlePinClick(pin) : handleFileClick(pin.file_path, { split: 'right' })}
                      onRemovePin={handleUnpinFile}
                    />
                  ) : activeView === 'aiTeam' ? (
                    <div data-ai-team-scroll className="h-full overflow-auto bg-surface-950 px-3 py-4 sm:px-6 lg:px-8"><div className="mx-auto max-w-6xl"><AITeamHome projects={projects} sessions={appSessions} activeSessionId={activeSessionId} onSelectSession={handleSelectSession} onNewSession={handleNewSession} onOpenProjectHome={(project) => { useFileStore.getState().openSystemTab('projectFiles', { refId: project.id, title: t('layout:namedHome', { name: project.agent?.displayName || project.name }), icon: project.agent?.face || '✨' }); useSessionStore.getState().setActiveView('chat'); }} /></div></div>
                  ) : activeView === 'aiServices' && aiServicesEnabled ? (
                    <AIServiceHome />
                  ) : activeView === 'beta' ? (
                    <BetaPanel />
                  ) : activeView === 'projectFiles' && activeTabId === null && !activeSystemTabId ? (
                    <FilesWorkspace onFileClick={handleFileClick} onRequestFileTree={requestFileTree} initialProjectId={capabilityProjectId} />
                  ) : (
                    /* ═══ Global multi-tab shell (v3, 2026-05-24, path B) ═══
                       FileTabBar renders chat tabs (session bookmarks) + file tabs.
                       activeTabId === null → ChatPanel (single instance, follows
                         activeSessionId — the active chat tab. Kept mounted for
                         scroll/input state preservation)
                       activeTabId !== null → ContextPanel embedded inline
                       Chat tabs are bookmarks: clicking switches activeSessionId
                       via handleSelectChatSession (no per-tab ChatPanel mount).
                       See: workspace/decisions/2026-05-22-global-multi-tab-shell.md
                    */
                    <>
                      <FileTabBar onSelectChatSession={handleSelectChatSession} onRenameSession={handleRenameSession} onReloadFile={requestFile} />
                      <div className={activeTabId === null && !activeSystemTabId ? 'tower-main-content-surface flex-1 flex flex-col min-h-0' : 'hidden'}>
                        <ChatPanel
                          onSend={handleSendMessage}
                          onAbort={abort}
                          onSafeStop={requestSafeStop}
                          onFileClick={handleMessageFileClick}
                          onAnswerQuestion={answerQuestion}
                          onLoadMore={loadMoreMessages}
                        />
                      </div>
                      <div className={activeTabId === null && activeSystemTabId ? 'tower-main-content-surface flex-1 flex flex-col min-h-0' : 'hidden'}>
                        {activeSystemTabKind === 'schedule' && activeSystemTab?.refId ? (
                          <ScheduleTabView automationId={activeSystemTab.refId} tabId={activeSystemTab.id} />
                        ) : activeSystemTabKind === 'projectFiles' ? (
                          <ProjectHome
                            project={projectHomeProject}
                            onOpenFiles={() => {
                              useSettingsStore.getState().setCapabilityProjectId(projectHomeProject?.id || activeSystemTabRefId || null);
                              useFileStore.getState().closeSystemTab(activeSystemTabId!);
                              useSessionStore.getState().setActiveView('projectFiles');
                            }}
                            onOpenFile={(path) => handleFileClick(path, { split: 'right' })}
                          />
                        ) : (
                          <PublishPanel open onClose={() => useFileStore.getState().closeSystemTab(activeSystemTabId!)} variant="embedded" />
                        )}
                      </div>
                      <div className={activeTabId !== null ? 'tower-main-content-surface flex-1 flex flex-col min-h-0' : 'hidden'}>
                        <ErrorBoundary fallbackLabel="File viewer error">
                          <ContextPanel
                            onSave={handleSaveFile}
                            onReload={handleReloadFile}
                            onRenamePersonalFile={handleRenamePersonalFile}
                            onFileNavigate={requestFile}
                            hideTabBar
                            fullScreen
                          />
                        </ErrorBoundary>
                      </div>
                    </>
                  )}
                </ErrorBoundary>
              </div>
            </main>

            {splitTabId && contextPanelOpen && activeView !== 'kanban' && activeView !== 'schedules' && activeView !== 'automations' && activeView !== 'history' && (
              <>
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t('layout:resizeViewer')}
                  title={t('layout:resizeViewerHint')}
                  onPointerDown={handleViewerPaneResizeStart}
                  className="group relative z-20 w-2 shrink-0 cursor-col-resize bg-surface-950"
                >
                  <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-surface-700/70 transition-colors group-hover:bg-primary-400" />
                  <div className="absolute inset-y-0 left-1/2 w-5 -translate-x-1/2" />
                </div>
                <main data-tour-id="viewer-pane" className="min-w-0 shrink-0 flex justify-center contain-layout" style={{ width: viewerPaneWidth }}>
                  <div onMouseDown={() => setActiveFilePane('extra')} className={`tower-main-shell tower-artifact-shell tower-viewer-shell relative overflow-hidden w-full flex flex-col h-full shadow-xl shadow-black/10 bg-surface-950 ${activeFilePane === 'extra' ? 'ring-1 ring-primary-500/25' : 'ring-1 ring-transparent'} ${artifactFlashActive ? 'tower-artifact-flash' : ''}`}>
                    <div className="tower-main-tabbar flex shrink-0 items-end bg-surface-950/45 px-1.5 pt-1.5 pb-0 text-sm leading-none select-none">
                      <div className="flex h-7 shrink-0 items-center px-2 text-[12px] font-medium text-surface-300" title={t('layout:viewerDescription')}>
                        {t('layout:viewer')}
                      </div>
                      <div className="relative min-w-0 flex-1">
                        <div ref={viewerTabbarRef} className="min-w-0 overflow-x-auto scrollbar-none">
                          <div className="flex min-w-full items-end gap-0.5">
                            <DndContext
                              sensors={viewerTabSensors}
                              collisionDetection={closestCenter}
                              onDragEnd={handleViewerTabDragEnd}
                            >
                              <SortableContext items={extraTabs.map((tab) => `viewer-file:${tab.id}`)} strategy={horizontalListSortingStrategy}>
                                {extraTabs.map((tab) => (
                                  <div key={tab.id} data-viewer-tab-id={tab.id} className="min-w-[5.5rem] max-w-[14rem] flex-[1_1_0]">
                                    <SortableTabShell id={`viewer-file:${tab.id}`} className="!min-w-0 !flex-1">
                                      <FileTabChip
                                        tab={tab}
                                        isActive={tab.id === splitTabId}
                                        isMobile={isMobile}
                                        onSelect={() => useFileStore.getState().openSplitTab(tab.id, 'right')}
                                        onClose={() => useFileStore.getState().closeTab(tab.id)}
                                        onPin={() => {
                                          useFileStore.getState().pinTab(tab.id);
                                          toastQuiet(tab.pinned ? t('layout:tabUnpinned') : t('layout:tabPinned'));
                                        }}
                                        onContextMenu={(e) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          setViewerTabMenu({ x: e.clientX, y: e.clientY, id: tab.id });
                                        }}
                                        className="!min-w-0 !max-w-none !flex-1"
                                      />
                                    </SortableTabShell>
                                  </div>
                                ))}
                              </SortableContext>
                            </DndContext>
                          </div>
                        </div>
                        {viewerTabbarOverflow.left && (
                          <button
                            type="button"
                            onClick={() => scrollViewerTabbarBy(-1)}
                            aria-label={t('layout:moreViewerTabsLeft')}
                            className="absolute left-0 top-1/2 z-20 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full border border-surface-700/70 bg-surface-900/90 text-[15px] text-surface-300 shadow-sm transition hover:border-surface-500 hover:bg-surface-800 hover:text-surface-50"
                          >
                            ‹
                          </button>
                        )}
                        {viewerTabbarOverflow.right && (
                          <button
                            type="button"
                            onClick={() => scrollViewerTabbarBy(1)}
                            aria-label={t('layout:moreViewerTabsRight')}
                            className="absolute right-0 top-1/2 z-20 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full border border-surface-700/70 bg-surface-900/90 text-[15px] text-surface-300 shadow-sm transition hover:border-surface-500 hover:bg-surface-800 hover:text-surface-50"
                          >
                            ›
                          </button>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => { void handleCreatePersonalNote(); }}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[18px] text-surface-300 transition hover:bg-surface-800 hover:text-surface-50"
                        title={t('layout:createBlankPersonalNote')}
                        aria-label={t('layout:createBlankPersonalNote')}
                      >
                        +
                      </button>
                      <button
                        type="button"
                        data-tour-id="viewer-collapse"
                        onClick={() => setContextPanelOpen(false)}
                        className="ml-1 flex h-7 shrink-0 items-center px-2 text-[12px] text-surface-400 hover:bg-surface-800 hover:text-surface-100"
                        title={t('layout:hideViewer')}
                        aria-label={t('layout:hideViewer')}
                      >
                        {t('layout:collapse')} ›
                      </button>
                    </div>
                    <ErrorBoundary fallbackLabel="Viewer pane error">
                      <div className="flex-1 flex flex-col min-h-0">
                        <ContextPanel tabId={splitTabId} onSave={handleSaveFile} onReload={handleReloadFile} onRenamePersonalFile={handleRenamePersonalFile} onFileNavigate={requestFile} hideTabBar fullScreen />
                      </div>
                    </ErrorBoundary>
                  </div>
                </main>
                {viewerResizing && (
                  <div className="fixed inset-0 z-[9998] cursor-col-resize" aria-hidden="true">
                    <div
                      ref={viewerResizeGuideRef}
                      className="absolute inset-y-0 w-px bg-primary-400 shadow-[0_0_0_1px_rgba(0,0,0,0.3)] will-change-transform"
                      style={{ right: viewerPaneWidth + 8 }}
                    />
                  </div>
                )}
              </>
            )}
            {viewerAvailable && !contextPanelOpen && activeView !== 'kanban' && activeView !== 'schedules' && activeView !== 'automations' && activeView !== 'history' && (
              <button
                type="button"
                onClick={() => {
                  if (extraTabs.length > 0) {
                    const nextTabId = splitTabId || extraTabs[0]?.id;
                    if (nextTabId) useFileStore.getState().openSplitTab(nextTabId, 'right');
                    setContextPanelOpen(true);
                    return;
                  }
                  void handleCreatePersonalNote();
                }}
                className="group flex w-9 shrink-0 flex-col items-center justify-center border-l border-surface-800 bg-surface-950/85 text-surface-400 transition hover:bg-surface-900 hover:text-surface-100"
                title={splitTabId ? t('layout:reopenViewer') : t('layout:createBlankPersonalNote')}
                aria-label={splitTabId ? t('layout:reopenViewer') : t('layout:createBlankPersonalNote')}
              >
                <span className="mb-2 rotate-90 whitespace-nowrap text-[12px] font-medium tracking-wide">Viewer</span>
                <span className="rounded-full border border-surface-700 px-1.5 py-0.5 text-[11px] group-hover:border-surface-500">{extraTabs.length > 0 ? extraTabs.length : '+'}</span>
              </button>
            )}
          </>
        ) : (
          /* Mobile: normal chat panel, kanban, history, or files */
          <main className="flex-1 min-w-0 flex justify-center">
            <div className={`tower-main-shell relative overflow-hidden w-full flex flex-col h-full shadow-xl shadow-black/20 ${activeView === 'chat' && !activeSystemTabId ? 'bg-surface-950/80 backdrop-blur-3xl' : 'bg-surface-950'}`}>
              {(!activeSystemTabId && (activeView === 'chat' || activeView === 'rooms')) && (
                <img src={appBackgroundSrc} alt="" aria-hidden="true" onError={() => { if (appBackgroundSrc !== towerBg) setAppBackgroundSrc(towerBg); }} className={`pointer-events-none select-none absolute inset-0 w-full h-full ${isCustomAppBackground ? 'object-contain opacity-[0.04]' : 'object-cover opacity-[0.12]'} z-0`} style={{ backgroundColor: isCustomAppBackground ? '#050505' : undefined, maskImage: 'radial-gradient(ellipse 90% 90% at 50% 50%, black 30%, transparent 75%)', WebkitMaskImage: 'radial-gradient(ellipse 90% 90% at 50% 50%, black 30%, transparent 75%)' }} />
              )}
              <ErrorBoundary fallbackLabel="Chat error">
                {activeView === 'kanban' ? (
                  <KanbanBoard />
                ) : activeView === 'schedules' && !activeSystemTabId ? (
                  <SchedulePanel />
                ) : activeView === 'automations' ? (
                  <AutomationPanel />
                ) : activeView === 'history' ? (
                  <HistoryPanel />
                ) : activeView === 'inbox' ? (
                  <InboxPanel onSelectSession={handleSelectSession} />
                ) : activeView === 'work' ? (
                  <ChallengeTimelinePanel />
                ) : activeView === 'favorites' ? (
                  <FavoritesPanel
                    projects={projects}
                    onOpenPin={(pin) => pin.file_type === 'folder' ? void handlePinClick(pin) : handleFileClick(pin.file_path, { split: 'right' })}
                    onRemovePin={handleUnpinFile}
                  />
                ) : activeView === 'aiTeam' ? (
                  <div data-ai-team-scroll className="h-full overflow-auto bg-surface-950 px-3 py-4"><AITeamHome projects={projects} sessions={appSessions} activeSessionId={activeSessionId} onSelectSession={handleSelectSession} onNewSession={handleNewSession} onOpenProjectHome={(project) => { useFileStore.getState().openSystemTab('projectFiles', { refId: project.id, title: t('layout:namedHome', { name: project.agent?.displayName || project.name }), icon: project.agent?.face || '✨' }); useSessionStore.getState().setActiveView('chat'); }} /></div>
                ) : activeView === 'aiServices' && aiServicesEnabled ? (
                  <AIServiceHome />
                ) : activeView === 'beta' ? (
                  <BetaPanel />
                ) : activeView === 'projectFiles' && activeTabId === null && !activeSystemTabId ? (
                  <FilesWorkspace onFileClick={handleFileClick} onRequestFileTree={requestFileTree} initialProjectId={capabilityProjectId} />
                ) : activeSystemTabId ? (
                  activeSystemTabKind === 'schedule' && activeSystemTab?.refId ? (
                    <ScheduleTabView automationId={activeSystemTab.refId} tabId={activeSystemTab.id} />
                  ) : activeSystemTabKind === 'projectFiles' ? (
                    <ProjectHome
                      project={projectHomeProject}
                      onOpenFiles={() => {
                        useSettingsStore.getState().setCapabilityProjectId(projectHomeProject?.id || activeSystemTabRefId || null);
                        useFileStore.getState().closeSystemTab(activeSystemTabId!);
                        useSessionStore.getState().setActiveView('projectFiles');
                      }}
                      onOpenFile={(path) => handleFileClick(path, { split: 'right' })}
                    />
                  ) : (
                    <PublishPanel open onClose={() => useFileStore.getState().closeSystemTab(activeSystemTabId!)} variant="embedded" />
                  )
                ) : activeView === 'rooms' ? (
                  <RetiredChannelNotice />
                ) : isMobile && newSessionCreating ? (
                  <div
                    role="status"
                    aria-live="polite"
                    data-testid="new-session-loading"
                    className="relative z-10 flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
                  >
                    <div className="h-7 w-7 animate-spin rounded-full border-2 border-surface-700 border-t-primary-400" aria-hidden="true" />
                    <div>
                      <p className="text-sm font-medium text-surface-100">{t('layout:preparingNewSession')}</p>
                      <p className="mt-1 text-xs text-surface-400">{t('layout:pleaseWait')}</p>
                    </div>
                  </div>
                ) : (
                  <ChatPanel
                    onSend={handleSendMessage}
                    onAbort={abort}
                    onSafeStop={requestSafeStop}
                    onFileClick={handleMessageFileClick}
                    onAnswerQuestion={answerQuestion}
                  />
                )}
              </ErrorBoundary>
            </div>
          </main>
        )}

        {aiPanelOpen && aiPanelContextType === 'session' && <AiPanel onFileClick={handleMessageFileClick} />}
      </div>

      <UploadPanel />

      <AITeamQuickPanel
        open={aiQuickPanelOpen}
        projects={projects}
        sessions={appSessions}
        activeSessionId={activeSessionId}
        onClose={() => setAiQuickPanelOpen(false)}
        onSelectSession={handleSelectSession}
        onOpenHome={(project) => { useFileStore.getState().openSystemTab('projectFiles', { refId: project.id, title: t('layout:namedHome', { name: project.agent?.displayName || project.name }), icon: project.agent?.face || '✨' }); useSessionStore.getState().setActiveView('chat'); }}
        onNewTeammate={() => window.dispatchEvent(new CustomEvent('tower-start-agent-academy'))}
        onOpenAll={() => useSessionStore.getState().setActiveView('aiTeam')}
      />

      {viewerShareFilePath && createPortal(
        <ShareModal filePath={viewerShareFilePath} onClose={() => setViewerShareFilePath(null)} />,
        document.body,
      )}
      {viewerTabMenu && createPortal(
        <div
          className="fixed z-50 min-w-[180px] py-1 bg-surface-900 border border-surface-700 rounded-md shadow-xl text-base text-gray-200"
          style={{ left: viewerTabMenu.x + 2, top: viewerTabMenu.y + 2 }}
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              const tab = useFileStore.getState().tabs.find((t) => t.id === viewerTabMenu.id);
              if (tab) window.dispatchEvent(new CustomEvent('tower-reveal-tab-target', { detail: { kind: 'file', path: tab.path } }));
              setViewerTabMenu(null);
            }}
            className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800"
          >
            {t('layout:goToFolder')}
          </button>
          <button
            onClick={() => {
              const tab = useFileStore.getState().tabs.find((t) => t.id === viewerTabMenu.id);
              setViewerTabMenu(null);
              if (!tab) return;
              openTowerFileInBrowserTab(tab.path);
            }}
            className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800"
          >
            {t('layout:openInNewBrowserTab')}
          </button>
          <button
            onClick={() => {
              const tab = useFileStore.getState().tabs.find((t) => t.id === viewerTabMenu.id);
              setViewerTabMenu(null);
              if (!tab) return;
              const token = localStorage.getItem('token');
              const url = `/api/files/serve?path=${encodeURIComponent(tab.path)}&download=1${token ? `&token=${encodeURIComponent(token)}` : ''}`;
              window.open(url, '_blank');
            }}
            className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800"
          >
            {t('layout:download')}
          </button>
          <button
            onClick={() => {
              const tab = useFileStore.getState().tabs.find((t) => t.id === viewerTabMenu.id);
              setViewerTabMenu(null);
              if (tab) setViewerShareFilePath(tab.path);
            }}
            className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800"
          >
            {t('layout:share')}
          </button>
          <button
            onClick={async () => {
              const tab = useFileStore.getState().tabs.find((t) => t.id === viewerTabMenu.id);
              setViewerTabMenu(null);
              if (!tab) return;
              try {
                await navigator.clipboard.writeText(tab.path);
                toastQuiet(t('layout:pathCopied'));
              } catch {
                toastQuiet(t('layout:pathCopyFailed'));
              }
            }}
            className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800"
          >
            {t('layout:copyPath')}
          </button>
          <div className="my-1 h-px bg-surface-800" />
          <button
            onClick={() => {
              const tab = useFileStore.getState().tabs.find((candidate) => candidate.id === viewerTabMenu.id);
              const favorite = tab ? usePinStore.getState().pins.find((pin) => pin.file_path === tab.path) : undefined;
              setViewerTabMenu(null);
              if (favorite) void handleUnpinFile(favorite.id);
              else if (tab) void handlePinFile(tab.path);
            }}
            className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800"
          >
            {(() => {
              const tab = useFileStore.getState().tabs.find((candidate) => candidate.id === viewerTabMenu.id);
              return tab && usePinStore.getState().pins.some((pin) => pin.file_path === tab.path) ? t('layout:removeFromFavorites') : t('layout:addToFavorites');
            })()}
          </button>
          <div className="my-1 h-px bg-surface-800" />
          <button
            onClick={() => {
              useFileStore.getState().moveTabToPane(viewerTabMenu.id, 'main');
              setViewerTabMenu(null);
            }}
            className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800 flex items-center justify-between gap-3"
          >
            <span>{t('layout:moveToMainTab')}</span>
            <span className="text-[12px] text-gray-500">↙</span>
          </button>
          <div className="my-1 h-px bg-surface-800" />
          <button
            onClick={() => { useFileStore.getState().closeTab(viewerTabMenu.id); setViewerTabMenu(null); }}
            className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800"
          >
            {t('layout:closeTab')}
          </button>
          <div className="my-1 h-px bg-surface-800" />
          <button
            onClick={() => {
              const tab = useFileStore.getState().tabs.find((t) => t.id === viewerTabMenu.id);
              if (tab) {
                useFileStore.getState().pinTab(viewerTabMenu.id);
                toastQuiet(tab.pinned ? t('layout:tabUnpinned') : t('layout:tabPinned'));
              }
              setViewerTabMenu(null);
            }}
            className="w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800 flex items-center justify-between gap-3"
          >
            <span>{useFileStore.getState().tabs.find((t) => t.id === viewerTabMenu.id)?.pinned ? t('layout:unpinTab') : t('layout:pinTab')}</span>
            <span className="text-[12px] text-gray-500">{t('layout:doubleClick')}</span>
          </button>
        </div>,
        document.body,
      )}

      {/* Mobile keeps the bottom navigation; desktop session diagnostics moved into tab context menus. */}
      {isMobile ? <MobileTabBar /> : null}

      {/* Modal chunks are not mounted until opened, so React.lazy stays truly deferred. */}
      {settingsOpen ? <SettingsPanel /> : null}
      {adminOpen ? <AdminPanel open onClose={() => setAdminOpen(false)} token={token} /> : null}
      {personalCredentialsOpen ? <PersonalCredentialsPanel open onClose={() => setPersonalCredentialsOpen(false)} token={token} /> : null}
      {skillsBrowserOpen ? <SkillsBrowser /> : null}
      {agentsPanelOpen ? <AgentsPanel /> : null}
      {helpOpen ? <ErrorBoundary fallbackLabel="Help panel error"><HelpPanel /></ErrorBoundary> : null}
      {publishOpen ? <PublishPanel open onClose={() => setPublishOpen(false)} /> : null}

      {/* Prompt editor modal */}
      {promptEditorOpen ? (
        <PromptEditor
          open
          onClose={() => { setPromptEditorOpen(false); setEditingPrompt(null); }}
          onSave={handlePromptSave}
          initial={editingPrompt ? { title: editingPrompt.title, content: editingPrompt.content } : undefined}
        />
      ) : null}
      </TourProvider>
    </div>
  );
}

/**
 * Keeps the visited-session message cache fresh without making the whole App
 * shell subscribe to chat streaming state. Streaming token updates should stay
 * in the chat pane; header/menu responsiveness depends on the shell staying on
 * a low-frequency state plane.
 */
function SessionMessageCacheSync() {
  const isStreaming = useChatStore((s) => s.isStreaming);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  useEffect(() => {
    if (!isStreaming && activeSessionId) {
      const msgs = useChatStore.getState().messages;
      if (msgs.length > 0) cacheSessionMessages(activeSessionId, msgs);
    }
  }, [isStreaming, activeSessionId]);

  return null;
}

function BottomBar({ requestFileTree }: { requestFileTree: (path?: string) => void }) {
  const { t } = useTranslation('layout');
  const isStreaming = useChatStore((s) => s.isStreaming);
  const availableModels = useModelStore((s) => s.availableModels);
  const piModels = useModelStore((s) => s.piModels);
  const localModels = useModelStore((s) => s.localModels);
  // Session-aware: prefer active session's stored modelUsed, fall back to
  // the global selectedModel. Look up the pretty name in both Claude and
  // Pi model lists — previously only searched availableModels, so Pi
  // names came out as raw IDs; also ignored per-session state entirely,
  // so the footer never changed when switching sessions.
  const { effectiveSelected } = useSessionAwareModel();
  const allModels = useMemo(() => [...availableModels, ...piModels, ...localModels], [availableModels, piModels, localModels]);
  const currentModelInfo = allModels.find((m) => m.id === effectiveSelected);
  // Fallback pretty-print for models no longer in the registry (e.g. retired
  // claude-opus-4-6 after upgrade). Capitalize family (Opus/Sonnet/Haiku) and
  // keep the version readable (4-6 → 4.6).
  const prettifyLegacy = (id: string): string => {
    const stripped = id.replace(/^pi:.*\//, '').replace(/^local:/, '');
    const m = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-\d+)?$/.exec(stripped);
    if (m) {
      const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
      return `${family} ${m[2]}.${m[3]} (legacy)`;
    }
    return stripped.replace(/-/g, ' ');
  };
  const model = currentModelInfo?.name || prettifyLegacy(effectiveSelected);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const cwd = activeSession?.cwd;
  const cost = useChatStore((s) => s.cost);
  const messages = useChatStore((s) => s.messages);
  const [cwdPickerOpen, setCwdPickerOpen] = useState(false);

  const isClaudeSession = activeSession?.engine === 'claude' || effectiveSelected.startsWith('claude-');
  const contextStat = computeContextUsageStat({
    cost,
    messages,
    modelContextWindow: currentModelInfo?.contextWindow,
  });
  const contextInput = contextStat.contextInput;
  const contextOutput = contextStat.contextOutput;
  const modelWindowTokens = contextStat.maxTokens;
  // For Claude SDK sessions, the operational budget is our auto-compact window
  // (500k), not necessarily the raw model window (200k/1M reported by SDK).
  // Showing the compact budget avoids confusing users with different reported
  // model windows while the practical "remaining" is governed by auto-compact.
  const displayWindowTokens = isClaudeSession ? CLAUDE_AUTO_COMPACT_WINDOW : modelWindowTokens;
  const contextUsed = contextInput;
  const hasContextMetric = contextUsed > 0 && displayWindowTokens > 0;
  const contextPct = hasContextMetric ? Math.min((contextUsed / displayWindowTokens) * 100, 100) : 0;
  const userMsgCount = activeSession?.userTurnCount ?? contextStat.userMsgCount;
  const contextTone = contextPct > 90 ? 'text-red-400/80'
    : contextPct > 70 ? 'text-amber-400/75'
      : 'text-gray-500 hover:text-gray-400';
  const contextFill = contextPct > 90 ? 'bg-red-400/65'
    : contextPct > 70 ? 'bg-amber-400/60'
      : 'bg-gray-500/45';

  return (
    <footer className="h-8 bg-surface-900 border-t border-surface-800 flex items-center px-4 text-[13px] text-gray-400 gap-5 shrink-0 tabular-nums font-medium tracking-wide relative overflow-hidden">
      {model && <span className="px-2 py-0.5 rounded-full bg-surface-800 border border-surface-700 text-gray-300 flex items-center gap-1.5"><span className="text-gray-500">{t('modelLabel')}</span><span>{model}</span></span>}
      {activeSessionId && (
        <span
          className={`px-1.5 py-0.5 rounded-full flex items-center gap-1.5 opacity-75 hover:opacity-100 transition-opacity ${contextTone}`}
          title={hasContextMetric
            ? `Provider-reported actual context: ${fmtTokensShort(contextInput)}\n${contextOutput > 0 ? `Last output: ${fmtTokensShort(contextOutput)}\n` : ''}${isClaudeSession ? `Model window reported: ${modelWindowTokens > 0 ? fmtTokensShort(modelWindowTokens) : 'unknown'}\nAuto-compact window: ${fmtTokensShort(CLAUDE_AUTO_COMPACT_WINDOW)}` : `Model window: ${fmtTokensShort(displayWindowTokens)}`}\nUser messages: ${userMsgCount}`
            : `No token metric yet. ${isClaudeSession ? `Auto-compact window: ${fmtTokensShort(CLAUDE_AUTO_COMPACT_WINDOW)}` : `Model window: ${displayWindowTokens > 0 ? fmtTokensShort(displayWindowTokens) : 'unknown'}`}`}
        >
          <span className="text-gray-600 tracking-[0.16em]">CTX</span>
          <span className="font-medium">{hasContextMetric ? `${contextPct < 1 ? '<1' : contextPct.toFixed(0)}%` : '—'}</span>
          <span className="h-1 w-10 overflow-hidden rounded-full bg-surface-800/45">
            <span
              className={`block h-full rounded-full transition-all duration-500 ${contextFill}`}
              style={{ width: `${hasContextMetric ? Math.max(contextPct, 1) : 0}%` }}
            />
          </span>
          <span className="hidden lg:inline text-gray-500">·</span>
          <span className="hidden lg:inline">{hasContextMetric ? `${fmtTokensShort(contextUsed)} / ${fmtTokensShort(displayWindowTokens)}` : `${displayWindowTokens > 0 ? fmtTokensShort(displayWindowTokens) : 'unknown'}`}</span>
          {userMsgCount > 0 && <span className="hidden 2xl:inline text-gray-500">· {t('userMessageCount', { count: userMsgCount })}</span>}
        </span>
      )}
      {cwdPickerOpen && activeSessionId && cwd && (
        <CwdPicker
          currentCwd={cwd}
          sessionId={activeSessionId}
          onClose={() => setCwdPickerOpen(false)}
          requestFileTree={requestFileTree}
        />
      )}
      <div className="flex items-center gap-4 ml-auto min-w-0">
        {cwd && (
          <button
            onClick={() => !isStreaming && setCwdPickerOpen(!cwdPickerOpen)}
            disabled={isStreaming}
            className={`flex min-w-0 items-center gap-1.5 text-gray-500 hover:text-gray-300 transition-colors ${isStreaming ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            title={isStreaming ? 'Cannot change while streaming' : `Working directory: ${cwd} (click to change)`}
          >
            <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" /></svg>
            <span className="truncate max-w-[420px]">{cwd.replace(/^\/home\/[^/]+/, '~')}</span>
            <svg className={`w-2.5 h-2.5 shrink-0 transition-transform ${cwdPickerOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
          </button>
        )}
      </div>
    </footer>
  );
}

function CwdPicker({ currentCwd, sessionId, onClose, requestFileTree }: { currentCwd: string; sessionId: string; onClose: () => void; requestFileTree: (path?: string) => void }) {
  const { t } = useTranslation('layout');
  const [browsePath, setBrowsePath] = useState(currentCwd);
  const [dirs, setDirs] = useState<{ name: string; path: string }[]>([]);
  const [inputValue, setInputValue] = useState(currentCwd);
  const [loading, setLoading] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const sessions = useSessionStore((s) => s.sessions);

  // Recent unique cwds from sessions
  const recentCwds = Array.from(new Set(sessions.map((s) => s.cwd).filter(Boolean)))
    .filter((c) => c !== currentCwd)
    .slice(0, 5);

  // Fetch directories
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

  // Click outside to close
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
        requestFileTree(newCwd);
        onClose();
      } else {
        const err = await res.json();
        toastError(err.error || 'Failed to change CWD');
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
    <div ref={pickerRef} className="absolute bottom-full left-0 mb-1 w-96 bg-surface-900 border border-surface-700 rounded-lg shadow-2xl z-50 overflow-hidden">
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
          <div className="text-[12px] text-gray-500 uppercase tracking-wider mb-1 px-1">Recent</div>
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
          <div className="py-4 text-center text-[13px] text-gray-500">Loading...</div>
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

export default App;
