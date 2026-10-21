import { useShortcutStore } from './stores/shortcut-store';
import { SecretariatDialog } from './features/secretariat/SecretariatDialog';
import { SecretariatPopup } from './features/secretariat/SecretariatPopup';
import { saveFileOperation } from './features/file-operation-feedback/save-operation';
import { acknowledgeFileSave } from './features/file-operation-feedback/save-acknowledgement';
import { useConfirm } from './hooks/useDialog';
import { clearCredentialIfCurrent, isCurrentCredential, restartAccountShell } from './utils/account-transition';
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Toaster } from 'sonner';
import { useTranslation } from 'react-i18next';
import { authErrorMessage } from './utils/auth-error-message';
import { Header } from './components/layout/Header';
import { Sidebar } from './components/layout/Sidebar';
import { ChatPanel } from './components/chat/ChatPanel';
import { McpOAuthNotice } from './components/chat/McpOAuthNotice';
import { ContextPanel } from './components/layout/ContextPanel';
import { FileTabBar } from './components/layout/FileTabBar';
import { ViewerPane } from './components/layout/ViewerPane';
import { AppContentRouter } from './components/layout/AppContentRouter';
import { SessionLinkNotice } from './components/layout/SessionLinkNotice';
import { AgentDraftPreview } from './components/files/AgentDraftPreview';

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
const LoginPage = lazyNamed<typeof import('./components/auth/LoginPage').LoginPage>(() => import('./components/auth/LoginPage'), 'LoginPage');
const SessionDirectoryPanel = lazyNamed<typeof import('./components/sessions/SessionDirectoryPanel').SessionDirectoryPanel>(() => import('./components/sessions/SessionDirectoryPanel'), 'SessionDirectoryPanel');
const AITeamQuickPanel = lazyNamed<typeof import('./components/agents/AITeamQuickPanel').AITeamQuickPanel>(() => import('./components/agents/AITeamQuickPanel'), 'AITeamQuickPanel');
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
const FirstRunInferenceSetup = lazyNamed<typeof import('./components/onboarding/FirstRunInferenceSetup').FirstRunInferenceSetup>(() => import('./components/onboarding/FirstRunInferenceSetup'), 'FirstRunInferenceSetup');
const WhatsNewModal = lazyNamed<typeof import('./components/onboarding/WhatsNewModal').WhatsNewModal>(() => import('./components/onboarding/WhatsNewModal'), 'WhatsNewModal');
const SchedulePanel = lazyNamed<typeof import('./components/schedule/SchedulePanel').SchedulePanel>(() => import('./components/schedule/SchedulePanel'), 'SchedulePanel');
const ScheduleTabView = lazyNamed<typeof import('./components/schedule/ScheduleTabView').ScheduleTabView>(() => import('./components/schedule/ScheduleTabView'), 'ScheduleTabView');
const AiPanel = lazyNamed<typeof import('./components/rooms/AiPanel').AiPanel>(() => import('./components/rooms/AiPanel'), 'AiPanel');
const RetiredChannelNotice = lazyNamed<typeof import('./components/rooms/RetiredChannelNotice').RetiredChannelNotice>(() => import('./components/rooms/RetiredChannelNotice'), 'RetiredChannelNotice');
const InboxPanel = lazyNamed<typeof import('./components/inbox/InboxPanel').InboxPanel>(() => import('./components/inbox/InboxPanel'), 'InboxPanel');
const SecretariatPanel = lazyNamed<typeof import('./features/secretariat/SecretariatPanel').SecretariatPanel>(() => import('./features/secretariat/SecretariatPanel'), 'SecretariatPanel');
const WorkHub = lazyNamed<typeof import('./components/work/WorkHub').WorkHub>(() => import('./components/work/WorkHub'), 'WorkHub');
const FavoritesPanel = lazyNamed<typeof import('./components/favorites/FavoritesPanel').FavoritesPanel>(() => import('./components/favorites/FavoritesPanel'), 'FavoritesPanel');
const UploadPanel = lazyNamed<typeof import('./components/uploads/UploadPanel').UploadPanel>(() => import('./components/uploads/UploadPanel'), 'UploadPanel');
const BetaPanel = lazyNamed<typeof import('./components/beta/BetaPanel').BetaPanel>(() => import('./components/beta/BetaPanel'), 'BetaPanel');
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { OfflineBanner } from './components/common/OfflineBanner';
import { UpdateBanner } from './components/common/UpdateBanner';
import { useAppUpdateCoordinator } from './hooks/useAppUpdateCoordinator';
import { useAppDataBootstrap, useAuthBootstrap, useBrandingBootstrap } from './hooks/useAppBootstrap';
import { useSessionLifecycle } from './hooks/useSessionLifecycle';
import { useSessionEventNavigation } from './hooks/useSessionEventNavigation';
import { useSessionSelection } from './hooks/useSessionSelection';
import { useSessionStartup } from './hooks/useSessionStartup';
import { useAppCollections } from './hooks/useAppCollections';
import { usePersonalViewerActions } from './hooks/usePersonalViewerActions';
import { useViewerDelivery } from './hooks/useViewerDelivery';
import { useFileOpenActions } from './hooks/useFileOpenActions';
import { useMessageExecution } from './hooks/useMessageExecution';
import { useAgentAcademy } from './hooks/useAgentAcademy';
import { useMobileKeyboardViewport } from './hooks/useMobileKeyboardViewport';
const PromptEditor = lazyNamed<typeof import('./components/prompts/PromptEditor').PromptEditor>(() => import('./components/prompts/PromptEditor'), 'PromptEditor');
import { SidebarResizeHandle, SIDEBAR_DEFAULT_WIDTH } from './components/layout/ResizeHandle';
import { MobileTabBar } from './components/layout/MobileTabBar';
import { useChatRuntime } from './hooks/useChatRuntime';
import { useUrlSync, parseUrl } from './hooks/useUrlSync';
import { lookupSessionLink } from './hooks/session-link-resolution';
import { useRoomStore } from './stores/room-store';
import { useAiPanelStore } from './stores/ai-panel-store';
import { useOnboarding } from './hooks/useOnboarding';
import { TourProvider } from './tours/TourProvider';
import { hasSeenTowerGuide } from './tours/tourState';
import { useTheme } from './hooks/useTheme';
import { useFontSize } from './hooks/useFontSize';
import { useMediaQuery } from './hooks/useMediaQuery';
import { useChatStore } from './stores/chat-store';
import { useSessionStore } from './stores/session-store';

import { useFileStore } from './stores/file-store';
import { usePromptStore } from './stores/prompt-store';
import { useSettingsStore } from './stores/settings-store';
import { useModelStore } from './stores/model-store';
import { useProjectStore } from './stores/project-store';
// normalizeContentBlocks moved to ChatPanel — lazy, only for visible ~20 messages
import { toastSuccess, toastError } from './utils/toast';
import { getFileExt } from './utils/file-path-links';
import { openPdfInBrowserTab } from './utils/pdf-open';
import { cacheSessionMessages } from './utils/session-message-cache';
import { logClientPerf, perfNow } from './utils/client-perf';
// SharedViewer / FileViewerPage moved to main.tsx routes (Phase 1.1, issue #11)

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
  const confirmAccountTransition = useConfirm();
  const confirmSessionArchive = useConfirm();
  const { t } = useTranslation(['auth', 'layout']);
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const { authStatus, setAuthStatus } = useAuthBootstrap(token, setToken);
  useEffect(() => {
    const check = () => { if (!isCurrentCredential(token)) restartAccountShell(); };
    const storage = (event: StorageEvent) => {
      if (event.storageArea === localStorage && (event.key === 'token' || event.key === null)) check();
    };
    window.addEventListener('storage', storage);
    window.addEventListener('focus', check);
    return () => { window.removeEventListener('storage', storage); window.removeEventListener('focus', check); };
  }, [token]);
  const [authError, setAuthError] = useState('');
  const [firstRunInferenceSetup, setFirstRunInferenceSetup] = useState(() => localStorage.getItem('tower:firstRunInferenceSetup') === 'pending');
  const [firstRunInferenceSetupResolved, setFirstRunInferenceSetupResolved] = useState(() => localStorage.getItem('tower:firstRunInferenceSetup') !== 'pending');

  const { appBackgroundSrc, clearAppBackground } = useBrandingBootstrap();
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
  const activeFilePane = useFileStore((s) => s.activeFilePane);
  const setActiveFilePane = useFileStore((s) => s.setActiveFilePane);
  const [secretariatOpen, setSecretariatOpen] = useState(false);
  useEffect(() => {
    const open = () => setSecretariatOpen(true);
    window.addEventListener('secretariat-open', open);
    return () => window.removeEventListener('secretariat-open', open);
  }, []);
  const [aiQuickPanelOpen, setAiQuickPanelOpen] = useState(false);
  const [sessionDirectory, setSessionDirectory] = useState<{ projectId: string | null; label?: string | null; mode: 'active' | 'archived' } | null>(null);
  const handleNavigateSessions = useCallback(() => {
    setSessionDirectory(null);
  }, []);
  useEffect(() => {
    const toggle = () => setAiQuickPanelOpen((open) => !open);
    window.addEventListener('tower-toggle-ai-quick-panel', toggle);
    return () => window.removeEventListener('tower-toggle-ai-quick-panel', toggle);
  }, []);
  useEffect(() => {
    const openDirectory = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null; label?: string | null; mode?: 'active' | 'archived' }>).detail || {};
      setSessionDirectory({ projectId: detail.projectId ?? null, mode: detail.mode === 'archived' ? 'archived' : 'active', ...('label' in detail ? { label: detail.label ?? null } : {}) });
      useFileStore.getState().activateChatSlot();
    };
    const openArchive = () => {
      setSessionDirectory({ projectId: null, mode: 'archived' });
      useFileStore.getState().activateChatSlot();
    };
    window.addEventListener('tower-open-session-directory', openDirectory);
    window.addEventListener('tower-open-session-archive', openArchive);
    return () => {
      window.removeEventListener('tower-open-session-directory', openDirectory);
      window.removeEventListener('tower-open-session-archive', openArchive);
    };
  }, []);
  const artifactFlashTimerRef = useRef<number | null>(null);
  const [artifactFlashActive, setArtifactFlashActive] = useState(false);
  const [viewerAffordanceVisible, setViewerAffordanceVisible] = useState(() => localStorage.getItem('tower.viewerAffordanceVisible') === 'true');
  const isMobile = useSessionStore((s) => s.isMobile);

  useEffect(() => {
    if (!splitTabId || viewerAffordanceVisible) return;
    setViewerAffordanceVisible(true);
    localStorage.setItem('tower.viewerAffordanceVisible', 'true');
  }, [splitTabId, viewerAffordanceVisible]);

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

  const openTowerFileInBrowserTab = useCallback((path: string) => {
    if (getFileExt(path) === 'pdf') {
      openPdfInBrowserTab(path);
      return;
    }
    window.open(`/file-viewer?path=${encodeURIComponent(path)}`, '_blank', 'noopener,noreferrer');
  }, []);

  const { sendMessage, requestImmediateStop, abort, setActiveSession, requestFile, requestFileTree, saveFile, answerQuestion, connected, loadMoreMessages } = useChatRuntime(authStatus?.authEnabled === false || !!token);
  const { newSessionCreating, createSessionInDb, handleNewSession, handleNewSessionInFolder, handleDeleteSession, handleRenameSession, handleToggleFavorite } = useSessionLifecycle({ token, setActiveRuntimeSession: setActiveSession, confirmSessionArchive, t });
  const { theme } = useTheme();
  useFontSize();
  // Debounce isMobile transitions: a 32px BottomBar ↔ 64px MobileTabBar swap
  // is jarring if it flips on micro viewport jitter (zoom, scrollbar,
  // mid-reflow frame measurements). 300ms is short enough that real
  // resize/rotation still feels instant, long enough to absorb noise.
  const isMobileQuery = useMediaQuery('(max-width: 768px)', { debounceMs: 300 });
  const mobileKeyboardViewport = useMobileKeyboardViewport(isMobileQuery);
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

  const setRecentSessions = useSessionStore((s) => s.setRecentSessions);
  const sessionListRefreshRef = useRef({ lastAt: 0, inFlight: false });

  const refreshSessionList = useCallback(async (
    reason: 'ws-connected' | 'visibility' | 'focus' | 'sidebar-tab' | 'administrator-participation' | 'ai-response-completed',
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
    const requestStartedAt = Date.now();
    const refreshStartedAt = perfNow();
    try {
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetchWithRestartTolerantAuth(`${API_BASE}/sessions?limit=${STARTUP_SESSION_LIST_LIMIT}`, { headers });
      const responseMs = Math.round(perfNow() - refreshStartedAt);
      if (!isCurrentCredential(token)) return;
      if (res.status === 401) {
        if (token) clearCredentialIfCurrent(token);
        setToken(null);
        return;
      }
      if (!res.ok) {
        logClientPerf('session-list-refresh', { reason, status: res.status, responseMs, elapsedMs: responseMs }, { thresholdMs: 800 });
        return;
      }
      const parseStartedAt = perfNow();
      const data = await res.json();
      if (!isCurrentCredential(token)) return;
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
      setRecentSessions(data, { requestedAt: requestStartedAt });
    } catch (err) {
      console.warn(`[app] session list reconciliation failed (${reason}):`, err);
    } finally {
      sessionListRefreshRef.current.inFlight = false;
    }
  }, [authStatus, token, setRecentSessions]);


  const [emailEnrollmentChallenge, setEmailEnrollmentChallenge] = useState<{ challengeId:string; emailRequired:boolean; maskedEmail:string; resendAvailableAt:string } | null>(null);
  const [loginOtpChallenge, setLoginOtpChallenge] = useState<{ challengeId: string; maskedEmail: string; resendAvailableAt: string } | null>(null);

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
        setAuthError(authErrorMessage(data.error, data.code));
        return;
      }
      if (!isSetup && res.status === 202 && data.enrollmentRequired === true && typeof data.challengeId === 'string') {
        setEmailEnrollmentChallenge({challengeId:data.challengeId,emailRequired:true,maskedEmail:'',resendAvailableAt:''});
        return;
      }
      if (!isSetup && res.status === 202 && data.otpRequired === true && typeof data.challengeId === 'string') {
        setLoginOtpChallenge({ challengeId: data.challengeId, maskedEmail: data.maskedEmail || '', resendAvailableAt: data.resendAvailableAt || '' });
        return;
      }
      if (!data.token || !data.user) {
        setAuthError(authErrorMessage(undefined));
        return;
      }
      setLoginOtpChallenge(null);
      setEmailEnrollmentChallenge(null);
      localStorage.setItem('token', data.token);
      if (data.user?.id) localStorage.setItem('userId', String(data.user.id));
      if (data.user?.username) localStorage.setItem('username', data.user.username);
      // 2026-05-22: localStorage('userRole') 미러링 폐기. JWT payload 가 단일 source.
      // 모든 UI gate 는 utils/auth.ts 의 헬퍼를 통해 token 에서 직접 읽는다.
      if (!isSetup) { restartAccountShell(); return; }
      setToken(data.token);
      // 로그인 성공 시 캐시 갱신 → 다음 앱 시작 시 로딩 없이 바로 메인 화면
      try { localStorage.setItem('tower:authCache', JSON.stringify({ authEnabled: true, hasUsers: true })); } catch {}
      if (isSetup) {
        localStorage.setItem('tower:firstRunInferenceSetup', 'pending');
        setFirstRunInferenceSetupResolved(false);
        setFirstRunInferenceSetup(true);
        setAuthStatus({ ...authStatus!, hasUsers: true });
      }
    } catch {
      setAuthError(t('auth:cannotConnect'));
    }
  };

  const handleLoginOtp = async (action: 'verify' | 'resend' | 'cancel', otp?: string) => {
    if (!loginOtpChallenge) return;
    setAuthError('');
    try {
      const res = await fetch(`${API_BASE}/auth/login/otp/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId: loginOtpChallenge.challengeId, ...(action === 'verify' ? { otp } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAuthError(authErrorMessage(data.error, data.code));
        if (res.status === 404 || res.status === 410) setLoginOtpChallenge(null);
        return;
      }
      if (action === 'cancel') { setLoginOtpChallenge(null); return; }
      if (action === 'resend') {
        if (data.otpRequired && data.challengeId) {
          setLoginOtpChallenge({ challengeId: data.challengeId, maskedEmail: data.maskedEmail || '', resendAvailableAt: data.resendAvailableAt || '' });
          return true;
        }
        setAuthError(authErrorMessage(undefined));
        return false;
      }
      if (!data.token || !data.user) { setAuthError(authErrorMessage(undefined)); return; }
      localStorage.setItem('token', data.token);
      if (data.user.id) localStorage.setItem('userId', String(data.user.id));
      if (data.user.username) localStorage.setItem('username', data.user.username);
      setLoginOtpChallenge(null);
      restartAccountShell();
      try { localStorage.setItem('tower:authCache', JSON.stringify({ authEnabled: true, hasUsers: true })); } catch {}
    } catch { setAuthError(t('auth:cannotConnect')); }
  };

  const handleEmailEnrollment = async (action:'email'|'verify'|'resend'|'cancel', value?:string) => {
    if (!emailEnrollmentChallenge) return false;
    setAuthError('');
    try {
      const res=await fetch(`${API_BASE}/auth/login/enrollment/${action}`, {
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({challengeId:emailEnrollmentChallenge.challengeId,...(action==='email'?{email:value}:action==='verify'?{otp:value}:{})}),
      });
      const data=await res.json().catch(()=>({}));
      if (!res.ok) {
        const unavailable = action==='email' && data.error==='Email address is unavailable';
        setAuthError(authErrorMessage(data.error, data.code));
        if ((res.status===404 || res.status===410) && !unavailable) setEmailEnrollmentChallenge(null);
        return false;
      }
      if (action==='cancel') {setEmailEnrollmentChallenge(null); return true;}
      if (action==='email' || action==='resend') {
        if (data.enrollmentRequired && data.challengeId) {
          setEmailEnrollmentChallenge({challengeId:data.challengeId,emailRequired:false,maskedEmail:data.maskedEmail||'',resendAvailableAt:data.resendAvailableAt||''});
          return true;
        }
        setAuthError(authErrorMessage(undefined)); return false;
      }
      if (!data.token || !data.user) {setAuthError(authErrorMessage(undefined));return false;}
      localStorage.setItem('token',data.token);
      if (data.user.id) localStorage.setItem('userId',String(data.user.id));
      if (data.user.username) localStorage.setItem('username',data.user.username);
      setEmailEnrollmentChallenge(null);
      restartAccountShell();
      try {localStorage.setItem('tower:authCache',JSON.stringify({authEnabled:true,hasUsers:true}));} catch {}
      return true;
    } catch {setAuthError(t('auth:cannotConnect'));return false;}
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
      if (!res.ok) return { ok: false, message: authErrorMessage(data.error, data.code) };
      if (data.approvalMode === 'manual' || data.user?.approval_status === 'pending') {
        return { ok: true, message: t('auth:signupPendingApproval') };
      }
      return { ok: true, message: t('auth:signupSubmitted') };
    } catch {
      return { ok: false, message: t('auth:cannotConnect') };
    }
  };

  const handleSelectSession = useSessionSelection({ token, setActiveRuntimeSession: setActiveSession });
  const markStartupSessionListLoaded = useCallback(() => { sessionListRefreshRef.current.lastAt = Date.now(); }, []);
  const { sessionsLoaded, sessionLinkState, setSessionLinkState } = useSessionStartup({ token, setToken, authStatus, onSelectSession: handleSelectSession, onSessionListLoaded: markStartupSessionListLoaded });

  // Phase 1.2 + 2 (issue #11): back/forward navigation landed on a different
  // session than the store holds. `sessionKey` 는 short_code 또는 UUID — sessions
  // 목록에서 둘 다 매칭한다.
  const handlePopSession = useCallback((sessionKey: string | null) => {
    if (!sessionKey) {
      setSessionLinkState(null);
      useFileStore.getState().activateChatSlot();
      setActiveSessionId(null);
      return;
    }
    setSessionLinkState({ kind: 'loading' });
    setActiveSessionId(null);
    useChatStore.getState().setSessionId(null);
    useChatStore.getState().clearMessages();
    useFileStore.getState().activateChatSlot();
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    void lookupSessionLink(sessionKey, headers).then(async result => {
      // Ignore a previous lookup after another browser navigation.
      if (parseUrl(window.location.pathname, window.location.search).sessionKey !== sessionKey) return;
      if (result.kind === 'session') {
        await handleSelectSession(result.session);
        if (parseUrl(window.location.pathname, window.location.search).sessionKey === sessionKey) setSessionLinkState(null);
      } else {
        setActiveSessionId(null);
        useChatStore.getState().setSessionId(null);
        useChatStore.getState().clearMessages();
        setSessionLinkState(result);
      }
    });
  }, [handleSelectSession, setActiveSessionId, setSessionLinkState, token]);

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
  useUrlSync({ onPopSession: handlePopSession, onPopRoom: handlePopRoom }, sessionsLoaded, !!sessionLinkState);

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
        // Mobile browsers can suspend or silently drop WebSocket frames while
        // backgrounded. Foreground return is a recovery boundary, so bypass the
        // normal 15s freshness gate; the in-flight guard still deduplicates the
        // paired visibility/focus events.
        void refreshSessionList('visibility', { minIntervalMs: 0, force: true });
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


  useEffect(() => {
    const refreshParticipation = () => { void refreshSessionList('administrator-participation', { minIntervalMs: 0 }); };
    const refreshAiResponse = () => { void refreshSessionList('ai-response-completed', { minIntervalMs: 0, force: true }); };
    window.addEventListener('tower-administrator-participation-changed', refreshParticipation);
    window.addEventListener('tower:session-ai-response-completed', refreshAiResponse);
    return () => {
      window.removeEventListener('tower-administrator-participation-changed', refreshParticipation);
      window.removeEventListener('tower:session-ai-response-completed', refreshAiResponse);
    };
  }, [refreshSessionList]);



  const { handleFileClick } = useFileOpenActions({ token, requestFile, triggerArtifactFlash, t });

  const {
    revealPersonalViewer,
    openPersonalFileInViewer,
    openPersonalMaterialsInViewer,
    openPersonalTodosInViewer,
    openPersonalArchiveInViewer,
    handleReloadFile,
    handleRenamePersonalFile,
    handleCreatePersonalNote,
    savePersonalFile,
  } = usePersonalViewerActions({ token, requestFile, triggerArtifactFlash, t });

  const { handleMessageFileClick } = useViewerDelivery({
    activeSessionId,
    handleFileClick,
    revealPersonalViewer,
    openPersonalFileInViewer,
    openPersonalMaterialsInViewer,
    openPersonalTodosInViewer,
    openPersonalArchiveInViewer,
    t,
  });

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

  const { handleSendMessage } = useMessageExecution({
    sendMessage,
    createSessionInDb,
    setActiveSessionId,
    clearMessages,
    setActiveRuntimeSession: setActiveSession,
  });

  const { aiTeamSurface, agentCreatorContent, closeAgentAcademy, closeAiTeamHome } = useAgentAcademy(sendMessage);

  // Onboarding: explicit guide/tour only + What's New (버전 업데이트)
  const userId = token ? localStorage.getItem('userId') : null;
  useEffect(() => { useShortcutStore.getState().reload(); }, [userId]);
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
        void saveFileOperation(path, () => fetch(`${API_BASE}/prompts/${match.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ title: match.title, content }),
        }), () => {
          usePromptStore.getState().updatePrompt(match.id, { content });
          acknowledgeFileSave(path, content);
        });
      }
      return;
    }
    if (path.startsWith('personal://')) {
      void savePersonalFile(path, content);
      return;
    }
    saveFile(path, content);
  }, [saveFile, savePersonalFile, token]);

  const {
    promptEditorOpen,
    editingPrompt,
    closePromptEditor,
    handlePinFile,
    handleUnpinFile,
    handlePinClick,
    handlePromptClick,
    handlePromptAdd,
    handlePromptEdit,
    handlePromptSave,
    handlePromptDelete,
  } = useAppCollections({ token, requestFile, requestFileTree, t });

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

  const [adminOpen, setAdminOpen] = useState(() => new URLSearchParams(window.location.search).get('oauth') === 'google-organization');
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
  const secretariatUserId = tokenPayload?.userId == null ? null : String(tokenPayload.userId);
  const canOpenAdminPanel = tokenPayload?.role === 'admin' || tokenPayload?.role === 'operator';
  const canOpenPersonalCredentials = !!tokenPayload?.role;
  const handleOpenAdmin = useCallback(() => setAdminOpen(true), []);
  const handleOpenPersonalCredentials = useCallback(() => setPersonalCredentialsOpen(true), []);

  const accountTransitionPending = useRef(false);
  const handleLogout = useCallback(async () => {
    if (accountTransitionPending.current) return;
    accountTransitionPending.current = true;
    try {
      if (!await confirmAccountTransition({ title: t('layout:accountSwitchTitle'), message: t('layout:accountSwitchWarning') })) return;
      if (!token || !isCurrentCredential(token)) { restartAccountShell(); return; }
      // Await cookie clearing: a late logout response must not erase the next login cookie.
      const response = await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include', headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error('Logout failed');
      if (clearCredentialIfCurrent(token)) restartAccountShell();
    } catch { toastError(t('layout:accountSwitchFailed')); }
    finally { accountTransitionPending.current = false; }
  }, [token, confirmAccountTransition, t]);

  useSessionEventNavigation({ onSelectSession: handleSelectSession });

  const activeView = useSessionStore((s) => s.activeView);
  useEffect(() => {
    if (!activeSessionId || !sessionLinkState) return;
    const key = parseUrl(window.location.pathname, window.location.search).sessionKey;
    const selected = useSessionStore.getState().sessions.find(session => session.id === activeSessionId);
    // A selection from the sidebar supersedes an unresolved link; the link's
    // own selection keeps its loading cover until message hydration completes.
    if (sessionLinkState.kind !== 'loading' || (key !== selected?.shortCode && key !== activeSessionId)) setSessionLinkState(null);
  }, [activeSessionId, sessionLinkState, setSessionLinkState]);

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
    if (activeView === 'kanban' || activeView === 'automations') {
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

  useAppDataBootstrap({
    authStatus,
    token,
    activeSessionId,
    firstRunInferenceSetup,
    setFirstRunInferenceSetup,
    setFirstRunInferenceSetupResolved,
    updateCoordinator,
  });

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
        otpChallenge={loginOtpChallenge}
        onOtpAction={handleLoginOtp}
        emailEnrollment={emailEnrollmentChallenge}
        onEmailEnrollmentAction={handleEmailEnrollment}
        onSignup={handleSignup}
        error={authError}
      />
    );
  }

  if (firstRunInferenceSetup && token && !firstRunInferenceSetupResolved) {
    return (
      <div className="app-bg flex min-h-full flex-col items-center justify-center" style={{ minHeight: '100dvh' }}>
        <div className="mb-2 text-xl font-bold text-primary-500">Tower</div>
        <div className="text-base text-surface-500">Loading...</div>
      </div>
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

  const sessionLinkSurface = sessionLinkState ? <SessionLinkNotice state={sessionLinkState} onOpenArchive={() => {
    setSessionLinkState(null);
    window.history.replaceState(null, '', '/');
    setSessionDirectory({ projectId: null, mode: 'archived' });
    useFileStore.getState().activateChatSlot();
  }} /> : null;
  const sessionDirectorySurface = sessionDirectory ? (
    <SessionDirectoryPanel sessions={appSessions} projects={projects} mode={sessionDirectory.mode} initialProjectId={sessionDirectory.projectId} initialLabel={sessionDirectory.label} onSelectSession={(session) => { setSessionDirectory(null); handleSelectSession(session); }} onClose={() => setSessionDirectory(null)} />
  ) : null;
  const favoritesSurface = (
    <FavoritesPanel
      projects={projects}
      onOpenPin={(pin) => pin.file_type === 'folder' ? void handlePinClick(pin) : handleFileClick(pin.file_path, { split: 'right' })}
      onRemovePin={handleUnpinFile}
    />
  );
  const aiTeamSurfaceContent = (
    <div data-ai-team-scroll className={`h-full overflow-auto bg-surface-950 px-3 py-4 ${isMobile ? '' : 'sm:px-6 lg:px-8'}`}>
      <div className={aiTeamSurface === 'creator' ? `relative min-h-full ${isMobile ? '' : 'mx-auto max-w-6xl'}` : isMobile ? undefined : 'mx-auto max-w-6xl'}>
        {aiTeamSurface === 'creator' && agentCreatorContent
          ? <AgentDraftPreview content={agentCreatorContent} onCancel={closeAgentAcademy} />
          : <AITeamHome projects={projects} onClose={closeAiTeamHome} isAdmin={tokenPayload?.role === 'admin'} sessions={appSessions} activeSessionId={activeSessionId} onSelectSession={handleSelectSession} onNewSession={handleNewSession} onOpenProjectHome={(project) => { useFileStore.getState().openSystemTab('projectFiles', { refId: project.id, title: t('layout:namedHome', { name: project.agent?.displayName || project.name }), icon: project.agent?.face || '✨' }); useSessionStore.getState().setActiveView('chat'); }} />}
      </div>
    </div>
  );
  const projectFilesSurface = <FilesWorkspace onFileClick={(path) => handleFileClick(path, { isDirectory: false })} onRequestFileTree={requestFileTree} initialProjectId={capabilityProjectId} />;
  const systemTabSurface = activeSystemTabKind === 'schedule' && activeSystemTab?.refId ? (
    <ScheduleTabView automationId={activeSystemTab.refId} tabId={activeSystemTab.id} />
  ) : activeSystemTabKind === 'projectFiles' ? (
    <ProjectHome
      project={projectHomeProject}
      onOpenFiles={() => {
        useSettingsStore.getState().setCapabilityProjectId(projectHomeProject?.id || activeSystemTabRefId || null);
        useFileStore.getState().closeSystemTab(activeSystemTabId!);
        useSessionStore.getState().setActiveView('projectFiles');
      }}
      onBackToTeam={() => { window.dispatchEvent(new CustomEvent('tower-open-ai-team-home')); useSessionStore.getState().setActiveView('aiTeam'); }}
      onOpenFile={(path) => handleFileClick(path, { split: 'right', isDirectory: false })}
    />
  ) : (
    <PublishPanel open onClose={() => useFileStore.getState().closeSystemTab(activeSystemTabId!)} variant="embedded" />
  );
  const mobileSessionLoadingSurface = newSessionCreating ? (
    <div role="status" aria-live="polite" data-testid="new-session-loading" className="relative z-10 flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-surface-700 border-t-primary-400" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-surface-100">{t('layout:preparingNewSession')}</p>
        <p className="mt-1 text-xs text-surface-400">{t('layout:pleaseWait')}</p>
      </div>
    </div>
  ) : null;

  return (
    <div
      className="flex flex-col overflow-hidden app-bg text-gray-100 font-sans selection:bg-primary-500/30 selection:text-primary-100 h-full"
      data-mobile-keyboard-open={mobileKeyboardViewport.keyboardOpen ? 'true' : 'false'}
      style={{ height: isMobileQuery ? mobileKeyboardViewport.height : '100dvh' }}
    >
      <Toaster position="top-right" theme={theme === 'light' ? 'light' : 'dark'} richColors closeButton />
      <McpOAuthNotice />
      {secretariatUserId && secretariatOpen && <SecretariatDialog key={`dialog:${secretariatUserId}:${token}`} onClose={() => setSecretariatOpen(false)}><SecretariatPanel /></SecretariatDialog>}
      {secretariatUserId && tokenPayload && ['admin', 'operator', 'member'].includes(tokenPayload.role) && <SecretariatPopup key={`${secretariatUserId}:${token}`} />}
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
        onViewDiff={handleViewDiff}
        onLogout={handleLogout}
        onSettingsClick={handleOpenSettings}
        onInboxClick={() => {
          useSessionStore.getState().setActiveView('inbox');
          setSidebarOpen(false);
        }}
        onSecretariatClick={() => setSecretariatOpen(true)}
        onSessionFileClick={(path) => handleFileClick(path)}
        onRequestFileTree={() => requestFileTree()}
        onSelectSession={handleSelectSession}
        onNavigateSessions={handleNavigateSessions}
        username={tokenPayload?.username}
        userRole={tokenPayload?.role}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
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
        {isMobile && mobileContextOpen && !sessionLinkState && (
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
                className={`tower-main-shell relative overflow-hidden w-full flex flex-col h-full shadow-xl shadow-black/10 ${activeTabId === null && !activeSystemTabId && (activeView === 'chat' || activeView === 'projectFiles' || activeView === 'rooms') ? 'bg-surface-950/80 backdrop-blur-3xl' : 'bg-surface-950'}`}
              >
                {(appBackgroundSrc && activeTabId === null && !activeSystemTabId && (activeView === 'chat' || activeView === 'projectFiles' || activeView === 'rooms')) && (
                  <img src={appBackgroundSrc} alt="" aria-hidden="true" onError={clearAppBackground} className="pointer-events-none select-none absolute inset-0 w-full h-full object-contain opacity-[0.04] z-0" style={{ backgroundColor: '#050505', maskImage: 'radial-gradient(ellipse 90% 90% at 50% 50%, black 30%, transparent 75%)', WebkitMaskImage: 'radial-gradient(ellipse 90% 90% at 50% 50%, black 30%, transparent 75%)' }} />
                )}
                <ErrorBoundary fallbackLabel="Chat error">
                  {sessionLinkSurface ?? <AppContentRouter
                    activeView={activeView}
                    hasActiveFileTab={activeTabId !== null}
                    hasActiveSystemTab={!!activeSystemTabId}
                    sessionDirectory={sessionDirectorySurface}
                    schedules={<SchedulePanel />}
                    inbox={<InboxPanel onSelectSession={handleSelectSession} />}
                    secretariat={<SecretariatPanel key={token ?? 'anonymous'} />}
                    work={<WorkHub onSelectSession={handleSelectSession} />}
                    favorites={favoritesSurface}
                    aiTeam={aiTeamSurfaceContent}
                    aiServices={<AIServiceHome />}
                    aiServicesEnabled={aiServicesEnabled}
                    beta={<BetaPanel />}
                    projectFiles={projectFilesSurface}
                    fallback={(
                      <>
                        <FileTabBar onSelectChatSession={handleSelectChatSession} onRenameSession={handleRenameSession} onReloadFile={requestFile} />
                        <div className={activeTabId === null && !activeSystemTabId ? `tower-main-content-surface min-w-0 max-w-full flex-1 flex flex-col min-h-0 overflow-hidden${appBackgroundSrc && activeView === 'chat' ? ' tower-branded-chat-surface' : ''}` : 'hidden'}>
                          <ChatPanel onSend={handleSendMessage} onAbort={abort} onStopImmediately={requestImmediateStop} onFileClick={handleMessageFileClick} onAnswerQuestion={answerQuestion} onLoadMore={loadMoreMessages} />
                        </div>
                        <div className={activeTabId === null && activeSystemTabId ? 'tower-main-content-surface flex-1 flex flex-col min-h-0' : 'hidden'}>{systemTabSurface}</div>
                        <div className={activeTabId !== null ? 'tower-main-content-surface flex-1 flex flex-col min-h-0' : 'hidden'}>
                          <ErrorBoundary fallbackLabel="File viewer error"><ContextPanel onSave={handleSaveFile} onReload={handleReloadFile} onRenamePersonalFile={handleRenamePersonalFile} onFileNavigate={requestFile} hideTabBar fullScreen /></ErrorBoundary>
                        </div>
                      </>
                    )}
                  />}
                </ErrorBoundary>
              </div>
            </main>

            {!sessionLinkState && <ViewerPane
              sidebarWidth={sidebarWidth}
              activeView={activeView}
              isMobile={isMobile}
              artifactFlashActive={artifactFlashActive}
              onCreatePersonalNote={handleCreatePersonalNote}
              onSaveFile={handleSaveFile}
              onReloadFile={handleReloadFile}
              onRenamePersonalFile={handleRenamePersonalFile}
              onFileNavigate={requestFile}
              onOpenInBrowserTab={openTowerFileInBrowserTab}
              onPinFile={handlePinFile}
              onUnpinFile={handleUnpinFile}
            />}
          </>
        ) : (
          /* Mobile: normal chat panel, kanban, history, or files */
          <main className="flex min-h-0 min-w-0 flex-1 justify-center">
            <div className={`tower-main-shell relative overflow-hidden w-full flex flex-col h-full shadow-xl shadow-black/20 ${activeView === 'chat' && !activeSystemTabId ? 'bg-surface-950/80 backdrop-blur-3xl' : 'bg-surface-950'}`}>
              {(appBackgroundSrc && !activeSystemTabId && (activeView === 'chat' || activeView === 'rooms')) && (
                <img src={appBackgroundSrc} alt="" aria-hidden="true" onError={clearAppBackground} className="pointer-events-none select-none absolute inset-0 w-full h-full object-contain opacity-[0.04] z-0" style={{ backgroundColor: '#050505', maskImage: 'radial-gradient(ellipse 90% 90% at 50% 50%, black 30%, transparent 75%)', WebkitMaskImage: 'radial-gradient(ellipse 90% 90% at 50% 50%, black 30%, transparent 75%)' }} />
              )}
              <ErrorBoundary fallbackLabel="Chat error">
                {sessionLinkSurface ?? <AppContentRouter
                  activeView={activeView}
                  hasActiveFileTab={activeTabId !== null}
                  hasActiveSystemTab={!!activeSystemTabId}
                  sessionDirectory={sessionDirectorySurface}
                  schedules={<SchedulePanel />}
                  inbox={<InboxPanel onSelectSession={handleSelectSession} />}
                  secretariat={<SecretariatPanel key={token ?? 'anonymous'} />}
                  work={<WorkHub onSelectSession={handleSelectSession} />}
                  favorites={favoritesSurface}
                  aiTeam={aiTeamSurfaceContent}
                  aiServices={<AIServiceHome />}
                  aiServicesEnabled={aiServicesEnabled}
                  beta={<BetaPanel />}
                  projectFiles={projectFilesSurface}
                  systemTab={systemTabSurface}
                  rooms={<RetiredChannelNotice />}
                  mobileSessionLoading={mobileSessionLoadingSurface}
                  fallback={<ChatPanel onSend={handleSendMessage} onAbort={abort} onStopImmediately={requestImmediateStop} onFileClick={handleMessageFileClick} onAnswerQuestion={answerQuestion} />}
                />}
              </ErrorBoundary>
            </div>
          </main>
        )}

        {aiPanelOpen && aiPanelContextType === 'session' && <AiPanel onFileClick={handleMessageFileClick} />}
      </div>

      <UploadPanel />

      {aiQuickPanelOpen ? <AITeamQuickPanel
        open
        projects={projects}
        sessions={appSessions}
        activeSessionId={activeSessionId}
        onClose={() => setAiQuickPanelOpen(false)}
        onSelectSession={handleSelectSession}
        onOpenHome={(project) => { useFileStore.getState().openSystemTab('projectFiles', { refId: project.id, title: t('layout:namedHome', { name: project.agent?.displayName || project.name }), icon: project.agent?.face || '✨' }); useSessionStore.getState().setActiveView('chat'); }}
        onNewTeammate={() => window.dispatchEvent(new CustomEvent('tower-start-agent-academy'))}
        onOpenAll={() => { closeAgentAcademy(); useSessionStore.getState().setActiveView('aiTeam'); }}
      /> : null}



      {/* Mobile keeps the bottom navigation; desktop session diagnostics moved into tab context menus. */}
      {isMobile && !mobileKeyboardViewport.hideNavigation ? <MobileTabBar onNavigateSessions={handleNavigateSessions} /> : null}

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
          onClose={closePromptEditor}
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

export default App;
