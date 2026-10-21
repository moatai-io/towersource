import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toastSuccess, toastError } from '../../utils/toast';
import { useSessionStore } from '../../stores/session-store';
import { useSettingsStore } from '../../stores/settings-store';
import { ModelSelector } from './ModelSelector';
import { getModelIdForBackend, useModelStore, useSessionAwareModel } from '../../stores/model-store';
import { confirmEngineSwitch } from '../../stores/engine-pick';
import { EngineSwitchConfirmModal } from './EngineSwitchConfirmModal';
import { getDefaultModelRank, getModelCompany, getModelDisplayName } from './model-display';
import { ModelTokenPrice } from './ModelTokenPrice';
import { GitPanel } from '../git/GitPanel';
import { NotificationBell } from './NotificationBell';
import { useProjectStore } from '../../stores/project-store';
import { useFileStore } from '../../stores/file-store';
import { deriveProjectSlugFromName, isValidProjectSlug, normalizeProjectSlugInput } from '../../utils/project-slug';
import { markTowerGuideSeen } from '../../tours/tourState';
import { SessionFilesMenuSection } from './SessionFilesMenuSection';

interface HeaderProps {
  connected: boolean;
  onToggleSidebar: () => void;
  onNewSession?: () => void;
  onAdminClick?: () => void;
  onPersonalCredentialsClick?: () => void;
  onPublishClick?: () => void;
  onViewDiff?: (diff: string) => void;
  onLogout?: () => void;
  onSettingsClick?: () => void;
  onInboxClick?: () => void;
  onSecretariatClick?: () => void;
  onSessionFileClick?: (path: string) => void;
  onRequestFileTree?: () => void;
  onSelectSession?: (session: import('../../stores/session-store').SessionMeta) => void;
  onNavigateSessions?: () => void;
  username?: string;
  userRole?: string;
  sidebarOpen?: boolean;
}

/* ─── Nav Switch (segmented toggle) ─── */
function NavTabs({ onRequestFileTree, onNavigateSessions }: { onRequestFileTree?: () => void; onNavigateSessions?: () => void }) {
  const { t } = useTranslation('layout');
  const sidebarTab = useSessionStore((s) => s.sidebarTab);
  const setSidebarTab = useSessionStore((s) => s.setSidebarTab);
  const activeView = useSessionStore((s) => s.activeView);
  const setActiveView = useSessionStore((s) => s.setActiveView);
  const sidebarOpen = useSessionStore((s) => s.sidebarOpen);
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const agentFirstEnabled = useSettingsStore((s) => s.serverConfig?.agentFirstEnabled === true);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = React.useState({ left: 0, width: 0 });

  // Build tab definitions
  const tabs = React.useMemo(() => {
    if (agentFirstEnabled) {
      return [
        { key: 'ai', label: t('conversationsNav'), badge: 0 },
        { key: 'files', label: t('files'), badge: 0 },
      ];
    }
    return [
      { key: 'ai', label: t('ai'), badge: 0 },
      { key: 'files', label: t('files'), badge: 0 },
    ];

  }, [agentFirstEnabled, t]);

  // Determine active key
  const activeKey = activeView === 'aiServices' ? ''
    : activeView === 'aiTeam' ? 'ai'
    : activeView === 'schedules' ? 'schedule'
    : activeView === 'projectFiles' ? 'files'
    : activeView === 'chat' && sidebarOpen && sidebarTab === 'files' ? 'files'
    : 'ai';

  // Update sliding indicator position
  React.useEffect(() => {
    if (!containerRef.current) return;
    const idx = tabs.findIndex(t => t.key === activeKey);
    const buttons = containerRef.current.querySelectorAll<HTMLButtonElement>('[data-nav-tab]');
    const btn = buttons[idx];
    if (btn) {
      const containerRect = containerRef.current.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      setIndicator({ left: btnRect.left - containerRect.left, width: btnRect.width });
    } else {
      setIndicator({ left: 0, width: 0 });
    }
  }, [activeKey, tabs]);

  const handleClick = (key: string) => {
    const store = useSessionStore.getState();
    switch (key) {
      case 'ai':
        // Sessions is an explicit destination, not only a sidebar toggle. Leave any
        // file/system surface and stale directory before restoring the conversation.
        useFileStore.getState().activateChatSlot();
        onNavigateSessions?.();
        store.setAiNavigationSurface();
        store.setSidebarOpen(true);
        break;
      case 'files': {
        const currentProjectId = sessions.find((session) => session.id === activeSessionId)?.projectId || null;
        setSidebarTab('files');
        useFileStore.getState().activateChatSlot();
        setActiveView('chat');
        store.setSidebarOpen(true);
        useSettingsStore.getState().setCapabilityProjectId(currentProjectId);
        onRequestFileTree?.();
        break;
      }
      case 'schedule':
        // Schedule is a primary workspace, not a sidebar toggle. Re-clicking the
        // active tab should keep users on Schedule instead of bouncing back to chat.
        setActiveView('schedules');
        store.setSidebarOpen(false);
        break;
    }
  };

  return (
    <div
      ref={containerRef}
      data-tour-id="main-nav"
      className="relative flex shrink-0 items-center overflow-x-auto rounded-lg bg-surface-850 p-0.5 scrollbar-none"
    >
      {/* Sliding indicator */}
      <div
        className="absolute top-0.5 bottom-0.5 rounded-md bg-surface-700/80 transition-all duration-200 ease-out pointer-events-none"
        style={{ left: indicator.left, width: indicator.width }}
      />
      {tabs.map(({ key, label, badge }) => (
        <button
          key={key}
          data-nav-tab
          data-tour-id={key === 'files' ? 'nav-files' : key === 'schedule' ? 'nav-schedule' : undefined}
          onClick={() => handleClick(key)}
          className={`relative z-10 shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-[13px] font-semibold tracking-wide transition-colors xl:px-3 ${
            activeKey === key
              ? 'text-primary-400'
              : 'text-surface-500 hover:text-gray-300'
          }`}
        >
          <span className="inline-flex items-center gap-1.5">
            {label}
            {badge > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary-500/18 px-1 text-[10px] font-bold tabular-nums text-primary-300" aria-label={t('workHub.unreadResults', { count: badge })}>
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}

/* ─── Light / Dark Toggle ─── */
function ThemeToggle() {
  const { t } = useTranslation('layout');
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const isLight = theme === 'light';

  return (
    <button
      onClick={() => setTheme(isLight ? 'dark' : 'light')}
      className="p-2 hover:bg-surface-800 rounded-lg transition-all active:scale-95 text-gray-400 hover:text-gray-200"
      title={isLight ? t('darkMode') : t('lightMode')}
      aria-label={isLight ? t('switchToDark') : t('switchToLight')}
    >
      {isLight ? (
        /* Moon icon */
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
      ) : (
        /* Sun icon */
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
      )}
    </button>
  );
}

/* ─── Inline Model Selector (for hamburger menu) ─── */
function ModelSelectorInline({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('layout');
  const {
    effectiveSelected,
    visibleClaudeModels,
    visiblePiModels,
    visibleLocalModels,
    pick,
    applyPickedModel,
  } = useSessionAwareModel();
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const [expanded, setExpanded] = React.useState(false);
  // Pending lossy engine switch awaiting user confirmation.
  const [pendingSwitch, setPendingSwitch] = React.useState<
    { modelId: string; fromEngine: string; toEngine: string } | null
  >(null);
  const [switchBusy, setSwitchBusy] = React.useState(false);
  const [switchError, setSwitchError] = React.useState<string | null>(null);
  const defaultPiModels = visiblePiModels
    .filter((model) => getDefaultModelRank(model) !== null)
    .sort((a, b) => getDefaultModelRank(a)! - getDefaultModelRank(b)!);
  const registryPiModels = visiblePiModels.filter((model) => getDefaultModelRank(model) === null);
  const allVisible = [...visibleClaudeModels, ...visiblePiModels, ...visibleLocalModels];
  const current = allVisible.find((m) => m.id === effectiveSelected)
    || allVisible[0]
    || { id: effectiveSelected, name: effectiveSelected.replace(/^pi:.*\//, '').replace(/-/g, ' '), badge: '' };

  if (!current) return null;

  const handlePick = (modelId: string) => {
    const decision = pick(modelId);
    setExpanded(false);
    if (decision.kind === 'needs_confirm') {
      // Lossy switch — hold the selection, ask the user first.
      setSwitchError(null);
      setPendingSwitch({ modelId, fromEngine: decision.fromEngine, toEngine: decision.toEngine });
    }
  };

  const handleConfirmSwitch = async () => {
    if (!pendingSwitch || !activeSessionId) return;
    setSwitchBusy(true);
    setSwitchError(null);
    const result = await confirmEngineSwitch(
      activeSessionId,
      pendingSwitch.toEngine,
      'user_request',
      getModelIdForBackend(pendingSwitch.modelId),
    );
    setSwitchBusy(false);
    if (result.ok) {
      applyPickedModel(pendingSwitch.modelId);
      setPendingSwitch(null);
    } else {
      setSwitchError(result.error?.message ?? t('engineSwitchFailed'));
    }
  };

  const handleCancelSwitch = () => {
    setPendingSwitch(null);
    setSwitchError(null);
  };

  return (
    <>
    {pendingSwitch && (
      <EngineSwitchConfirmModal
        fromEngine={pendingSwitch.fromEngine}
        toEngine={pendingSwitch.toEngine}
        busy={switchBusy}
        errorMessage={switchError}
        onConfirm={handleConfirmSwitch}
        onCancel={handleCancelSwitch}
      />
    )}
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 text-[14px] font-medium text-gray-300 bg-surface-800/80 border border-surface-700/50 px-2.5 py-1.5 rounded-lg hover:bg-surface-800 transition-all"
      >
        <div className="w-1.5 h-1.5 rounded-full bg-primary-400 shrink-0" />
        <span className="flex-1 text-left truncate">{getModelDisplayName(current, t)}</span>
        {current.badge && (
          <span className={`text-[11px] font-bold px-1 py-px rounded ${
            current.badge === 'OR'
              ? 'text-violet-300 bg-violet-500/20 border border-violet-500/30'
              : current.badge === 'AZ'
              ? 'text-sky-300 bg-sky-500/20 border border-sky-500/30'
              : current.badge === 'LOCAL'
              ? 'tone-pill tone-success'
              : 'text-purple-300 bg-purple-500/20 border border-purple-500/30'
          }`}>
            {current.badge}
          </span>
        )}
        <svg className={`w-3 h-3 text-surface-500 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="mt-1.5 rounded-lg border border-surface-700/50 bg-surface-850 overflow-hidden">
          {visibleClaudeModels.map((model) => (
            <button
              key={model.id}
              onClick={() => handlePick(model.id)}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-[13px] transition-colors ${
                model.id === effectiveSelected
                  ? 'bg-primary-600/15 text-primary-300'
                  : 'text-gray-400 hover:bg-surface-800 hover:text-gray-200'
              }`}
            >
              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${model.id === effectiveSelected ? 'bg-primary-400' : 'bg-surface-700'}`} />
              <span className="flex-1 text-left truncate">{getModelDisplayName(model, t)}</span>
              {model.badge && (
                <span className={`text-[11px] font-bold px-1 py-px rounded shrink-0 ${
                  model.badge === 'OR'
                    ? 'text-violet-300 bg-violet-500/20 border border-violet-500/30'
                    : model.badge === 'AZ'
                    ? 'text-sky-300 bg-sky-500/20 border border-sky-500/30'
                    : model.badge === 'LOCAL'
                    ? 'tone-pill tone-success'
                    : 'text-purple-300 bg-purple-500/20 border border-purple-500/30'
                }`}>
                  {model.badge}
                </span>
              )}
            </button>
          ))}
          {visiblePiModels.length > 0 && (
            <>
              {visibleClaudeModels.length > 0 && <div className="border-t border-surface-700/50 mx-2 my-0.5" />}
              {defaultPiModels.length > 0 && (
                <div className="mx-1.5 my-1 rounded-lg border border-primary-500/20 bg-primary-500/[0.04] py-0.5">
                  <div className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-primary-400/80">{t('defaultModels')}</div>
                  {defaultPiModels.map((model) => (
                    <button key={model.id} onClick={() => handlePick(model.id)} className={`w-full flex items-center gap-2 px-2 py-1.5 text-[13px] transition-colors ${model.id === effectiveSelected ? 'bg-primary-600/15 text-primary-300' : 'text-gray-400 hover:bg-surface-800 hover:text-gray-200'}`}>
                      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${model.id === effectiveSelected ? 'bg-primary-400' : 'bg-surface-700'}`} />
                      <span className="min-w-0 flex-1 text-left"><span className="block truncate font-medium">{getModelDisplayName(model, t)}</span><ModelTokenPrice model={model} /></span>
                    </button>
                  ))}
                </div>
              )}
              {registryPiModels.length > 0 && defaultPiModels.length > 0 && <div className="border-t border-surface-700/50 mx-2 my-0.5" />}
              {registryPiModels.map((model) => (
                <button key={model.id} onClick={() => handlePick(model.id)} className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-[13px] transition-colors ${model.id === effectiveSelected ? 'bg-primary-600/15 text-primary-300' : 'text-gray-400 hover:bg-surface-800 hover:text-gray-200'}`}>
                  <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${model.id === effectiveSelected ? 'bg-primary-400' : 'bg-surface-700'}`} />
                  <span className="min-w-0 flex-1 text-left"><span className="block truncate">{getModelDisplayName(model, t)}</span><ModelTokenPrice model={model} /></span>
                  {getModelCompany(model) && <span className="max-w-[88px] shrink-0 truncate text-[11px] text-surface-500">{getModelCompany(model)}</span>}
                </button>
              ))}
            </>
          )}
          {visibleLocalModels.length > 0 && (
            <>
              {(visibleClaudeModels.length > 0 || visiblePiModels.length > 0) && <div className="border-t border-surface-700/50 mx-2 my-0.5" />}
              <div className="px-2.5 pt-1 pb-0.5 tone-success tone-text text-[11px] font-semibold opacity-70 uppercase tracking-wider">{t('localLlm')}</div>
              {visibleLocalModels.map((model) => (
                <button
                  key={model.id}
                  onClick={() => handlePick(model.id)}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-[13px] transition-colors ${
                    model.id === effectiveSelected
                      ? 'bg-primary-600/15 text-primary-300'
                      : 'text-gray-400 hover:bg-surface-800 hover:text-gray-200'
                  }`}
                >
                  <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${model.id === effectiveSelected ? 'bg-primary-400' : 'bg-surface-700'}`} />
                  <span className="flex-1 text-left truncate">{getModelDisplayName(model, t)}</span>
                  {model.badge && (
                    <span className={`text-[11px] font-bold px-1 py-px rounded shrink-0 ${
                      model.badge === 'OR'
                        ? 'text-violet-300 bg-violet-500/20 border border-violet-500/30'
                        : model.badge === 'AZ'
                        ? 'text-sky-300 bg-sky-500/20 border border-sky-500/30'
                        : model.badge === 'LOCAL'
                        ? 'tone-pill tone-success'
                        : 'text-purple-300 bg-purple-500/20 border border-purple-500/30'
                    }`}>
                      {model.badge}
                    </span>
                  )}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
    </>
  );
}

/* ─── App Menu (☰) ─── */
function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

function isPathInsideRoot(path: string, rootPath: string): boolean {
  const normalizedPath = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

export function AppMenu({
  username, userRole, onAdminClick, onPublishClick, onViewDiff,
  onLogout, onSettingsClick, onInboxClick, onSecretariatClick, onSessionFileClick, onSelectSession, isMobile,
}: {
  username?: string;
  userRole?: string;
  onAdminClick?: () => void;
  onPersonalCredentialsClick?: () => void;
  onPublishClick?: () => void;
  onViewDiff?: (diff: string) => void;
  onLogout?: () => void;
  onSettingsClick?: () => void;
  onInboxClick?: () => void;
  onSecretariatClick?: () => void;
  onSessionFileClick?: (path: string) => void;
  onSelectSession?: (session: import('../../stores/session-store').SessionMeta) => void;
  isMobile?: boolean;
}) {
  const { t } = useTranslation('layout');
  const [open, setOpen] = React.useState(false);
  const [gitOpen, setGitOpen] = React.useState(false);
  const [newProjectOpen, setNewProjectOpen] = React.useState(false);
  const [npName, setNpName] = React.useState('');
  const [npSlug, setNpSlug] = React.useState('');
  const [npSlugTouched, setNpSlugTouched] = React.useState(false);
  const npInputRef = React.useRef<HTMLInputElement>(null);
  // Synchronous guard — prevents rapid Enter/click from creating duplicate
  // project folders (slug-collision suffix appears on 2nd call).
  // See workspace/decisions/2026-04-20-project-create-dedup.md
  const npSubmittingRef = React.useRef(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const setSkillsBrowserOpen = useSettingsStore((s) => s.setSkillsBrowserOpen);
  const towerRole = useSettingsStore((s) => s.serverConfig?.towerRole);
  const agentFirstEnabled = useSettingsStore((s) => s.serverConfig?.agentFirstEnabled === true);
  const aiServicesEnabled = useSettingsStore((s) => s.serverConfig?.aiServicesEnabled === true);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  // Reset sub-panels when menu closes
  React.useEffect(() => {
    if (!open) {
      setGitOpen(false);
      setNewProjectOpen(false);
      setNpName('');
      setNpSlug('');
      setNpSlugTouched(false);
    }
  }, [open]);


  // Auto-focus project name input
  React.useEffect(() => {
    if (newProjectOpen) npInputRef.current?.focus();
  }, [newProjectOpen]);

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const initial = (username || '?')[0].toUpperCase();
  const isOperatorOrAdmin = userRole === 'admin' || userRole === 'operator';
  // Internal dogfood only: server role is necessary but not sufficient.
  // Managed/standalone stay hidden, and full VMs must explicitly opt in.
  const showAgentAcademyBeta = towerRole === 'full' && agentFirstEnabled;

  const handleProjectNameChange = (value: string) => {
    setNpName(value);
    if (!npSlugTouched) setNpSlug(deriveProjectSlugFromName(value));
  };

  const handleProjectSlugChange = (value: string) => {
    setNpSlugTouched(true);
    setNpSlug(normalizeProjectSlugInput(value));
  };

  const resetNewProjectForm = () => {
    setNpName('');
    setNpSlug('');
    setNpSlugTouched(false);
  };

  const openAgentAcademy = () => {
    setNewProjectOpen(false);
    setOpen(false);
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('tower-start-agent-academy'));
    }, 0);
  };

  const handleCreateProject = async () => {
    if (npSubmittingRef.current) return;
    const trimmed = npName.trim();
    const slug = npSlug.trim();
    if (!trimmed) { setNewProjectOpen(false); return; }
    if (!isValidProjectSlug(slug)) {
      toastError(t('projectSlugRequired'));
      return;
    }
    npSubmittingRef.current = true;
    try {
      const token = localStorage.getItem('token');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('/api/projects', {
        method: 'POST', headers, body: JSON.stringify({ name: trimmed, slug }),
      });
      if (res.ok) {
        const project = await res.json();
        useProjectStore.getState().addProject(project);
      } else {
        const data = await res.json().catch(() => ({}));
        toastError(data.error || 'Failed to create project');
      }
    } catch {
      toastError('Failed to create project');
    } finally {
      npSubmittingRef.current = false;
      resetNewProjectForm();
      setNewProjectOpen(false);
      setOpen(false);
    }
  };

  const MenuItem = ({ icon, label, description, onClick, danger, shortcut, keepOpen, badge, testId }: {
    icon: React.ReactNode; label: string; description?: string; onClick?: () => void; danger?: boolean; shortcut?: string; keepOpen?: boolean; badge?: number; testId?: string;
  }) => (
    <button
      type="button"
      data-testid={testId}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onClick?.(); if (!keepOpen) setOpen(false); }}
      className={`flex min-h-10 w-full items-start gap-2.5 px-3 py-2 text-[14px] transition-colors ${
        danger
          ? 'text-red-400 hover:bg-red-950/30 hover:text-red-300'
          : 'text-gray-400 hover:bg-surface-800 hover:text-gray-200'
      }`}
    >
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block leading-5">{label}</span>
        {description && <span className="mt-0.5 block text-[12px] leading-4 text-surface-500">{description}</span>}
      </span>
      {badge != null && badge > 0 && <span className="mt-0.5 min-w-5 rounded-full bg-red-500 px-1.5 py-0.5 text-center text-[11px] font-bold leading-none text-white">{badge > 99 ? '99+' : badge}</span>}
      {shortcut && <span className="mt-0.5 font-mono text-[12px] text-surface-600">{shortcut}</span>}
    </button>
  );

  const MenuSection = ({ label }: { label: string }) => (
    <div className="px-3 pt-2 pb-1 text-[12px] font-semibold uppercase tracking-[0.14em] text-surface-600">
      {label}
    </div>
  );

  const Divider = () => <div className="border-t border-surface-800 my-1" />;

  return (
    <div ref={ref} className="relative">
      <button
        data-tour-id="app-menu"
        onClick={() => setOpen(!open)}
        className={`relative p-2 hover:bg-surface-800 rounded-lg transition-all active:scale-95 ${
          open ? 'bg-surface-800 text-gray-200' : 'text-gray-400 hover:text-gray-200'
        }`}
        title="Menu"
        aria-label="Menu"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {open && !gitOpen && !newProjectOpen && (
        <div className="absolute left-0 top-full mt-2 w-72 max-h-[calc(100dvh-4.5rem)] overflow-y-auto overscroll-contain bg-surface-900 border border-surface-700 rounded-xl shadow-2xl shadow-black/40 z-[100]">
          {/* User info header */}
          <div className="px-3 py-2.5 border-b border-surface-800 flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-full bg-primary-600/30 border border-primary-500/40 flex items-center justify-center shrink-0">
              <span className="text-[14px] font-bold text-primary-400">{initial}</span>
            </div>
            <div className="min-w-0">
              <div className="text-[15px] font-medium text-gray-200 truncate">{username || t('user')}</div>
              {userRole && <div className="text-[12px] text-gray-500 capitalize">{userRole}</div>}
            </div>
          </div>

          {/* ── Model Selector (inline) ── */}
          <div className="px-3 py-2 border-b border-surface-800">
            <div className="text-[12px] font-semibold text-surface-500 uppercase tracking-wider mb-1.5">{t('model')}</div>
            <ModelSelectorInline onClose={() => setOpen(false)} />
          </div>

          <div className="py-1">
            {/* ── Personal workspace ── */}
            <MenuSection label={t('mySpace')} />
            <MenuItem
              icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 3h18v5H3zM5 8v13h14V8M9 12h6" /></svg>}
              label={t('sessionTrash')}
              testId="global-nav-archive"
              onClick={() => window.dispatchEvent(new CustomEvent('tower-open-session-directory', { detail: { mode: 'archived' } }))}
            />
            {userRole !== 'guest' && userRole !== 'viewer' && (
              <MenuItem
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 19V7m0 12h16M8 15v-4m4 4V5m4 10V9" /></svg>}
                label={t('workHistory')}
                description={t('workHistoryDescription')}
                testId="global-nav-work"
                onClick={() => {
                  const store = useSessionStore.getState();
                  store.setActiveView('work');
                  store.setSidebarOpen(false);
                }}
              />
            )}
            <MenuItem
              icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}><path strokeLinecap="round" strokeLinejoin="round" d="M17 8h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2v4l-4-4H9M7 14H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-4l-4 4v-4Z" /></svg>}
              label={t('pendingReplies')}
              description={t('pendingRepliesDescription')}
              testId="global-nav-inbox"
              onClick={onInboxClick}
            />
            {onSecretariatClick && userRole !== 'guest' && userRole !== 'viewer' && (
              <MenuItem
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2 M9 3h6v4H9z M8 12h8 M8 16h5" /></svg>}
                label={t('secretariat')}
                description={t('secretariatDescription')}
                testId="global-nav-secretariat"
                onClick={onSecretariatClick}
              />
            )}
            {onSessionFileClick && (
              <SessionFilesMenuSection
                activeSessionId={activeSessionId}
                isMobile={isMobile}
                onFileClick={(path) => {
                  onSessionFileClick(path);
                  setOpen(false);
                }}
              />
            )}

            <Divider />

            {/* ── Operations ── */}
            <MenuSection label={t('operations')} />
            <MenuItem
              icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3M5 11h14M6 5h12a2 2 0 012 2v12H4V7a2 2 0 012-2z" /></svg>}
              label={t('automation')}
              description={t('automationDescription')}
              testId="global-nav-automation"
              onClick={() => {
                const store = useSessionStore.getState();
                store.setActiveView('schedules');
                store.setSidebarOpen(false);
              }}
            />
            {onPublishClick && (
              <MenuItem
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
                label={t('publishingHub')}
                description={t('publishingHubDescription')}
                onClick={onPublishClick}
                testId="global-nav-publishing"
              />
            )}

            <Divider />

            {/* ── Settings and management ── */}
            <MenuSection label={t('settingsAndManagement')} />
            <MenuItem
              icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>}
              label={t('mySettings')}
              testId="global-nav-settings"
              onClick={onSettingsClick}
            />
            <MenuItem
              icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>}
              label={t('skillsMarket')}
              description={t('skillsMarketDescription')}
              testId="global-nav-skills"
              onClick={() => { setSkillsBrowserOpen(true); }}
            />
            {isOperatorOrAdmin && (
              <>
                {/* ── Role-gated settings and management tools ── */}
                {onAdminClick && (
                  <MenuItem
                    icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0 1 12 2.944a11.955 11.955 0 0 1-8.618 3.04A12.02 12.02 0 0 0 3 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>}
                    label={userRole === 'operator' ? t('operatorPanel') : t('adminPanel')}
                    onClick={onAdminClick}
                  />
                )}
                {aiServicesEnabled && isOperatorOrAdmin && (
                  <MenuItem
                    icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 3v3m0 12v3M4.2 4.2l2.1 2.1m11.4 11.4 2.1 2.1M3 12h3m12 0h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /><circle cx="12" cy="12" r="4" /></svg>}
                    label={t('externalAgentDeployment')}
                    onClick={() => {
                      const store = useSessionStore.getState();
                      store.setActiveView('aiServices');
                      store.setSidebarOpen(false);
                    }}
                  />
                )}
                <MenuItem
                  icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>}
                  label={t('versionHistory')}
                  onClick={() => { setGitOpen(true); }}
                  keepOpen
                />
              </>
            )}

            <Divider />

            {/* ── Help ── */}
            <MenuSection label={t('sectionHelp')} />
            <MenuItem
              icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l3-1.5L15 20l-.75-3M7 10a5 5 0 1110 0c0 2.25-1.5 3.75-3 4.5H10c-1.5-.75-3-2.25-3-4.5z" /></svg>}
              label={t('startTowerTour')}
              onClick={() => {
                markTowerGuideSeen();
                window.dispatchEvent(new CustomEvent('tower-start-tour', { detail: { tourId: 'beginner' } }));
              }}
            />
            <MenuItem
              icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeWidth={1.5} /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" strokeWidth={2} strokeLinecap="round" /></svg>}
              label={t('help')}
              onClick={() => useSettingsStore.getState().setHelpOpen(true)}
            />

            <Divider />

            {/* Switching intentionally uses the same authenticated sign-out boundary. */}
            {onLogout && <MenuItem label={t('accountSwitchTitle')} onClick={onLogout} icon={<span aria-hidden="true">↔</span>} />}
            {/* ── Logout ── */}
            {onLogout && (
              <MenuItem
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>}
                label={t('logout')}
                onClick={onLogout}
                danger
              />
            )}
          </div>
        </div>
      )}

      {/* New Project sub-panel */}
      {open && newProjectOpen && (
        <div className="absolute left-0 top-full mt-2 w-64 max-h-[calc(100dvh-4.5rem)] overflow-y-auto overscroll-contain bg-surface-900 border border-surface-700 rounded-xl shadow-2xl shadow-black/40 z-[100]">
          <div className="px-3 py-2.5 border-b border-surface-800 flex items-center gap-2">
            <button
              onClick={() => { setNewProjectOpen(false); resetNewProjectForm(); }}
              className="p-1.5 hover:bg-surface-800 rounded-lg transition-colors text-gray-400 hover:text-gray-200 active:scale-95"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <span className="text-[15px] font-semibold text-gray-200">{t('newProject')}</span>
          </div>
          <div className="p-3">
            <label className="block text-[12px] text-surface-500 uppercase tracking-wider font-medium mb-1">
              {t('projectDisplayName')}
            </label>
            <input
              ref={npInputRef}
              value={npName}
              onChange={(e) => handleProjectNameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateProject();
                if (e.key === 'Escape') { setNewProjectOpen(false); resetNewProjectForm(); }
              }}
              placeholder={t('projectNamePlaceholder')}
              className="w-full bg-surface-800 border border-surface-700 rounded-lg text-[15px] text-gray-200 px-3 py-2 placeholder-surface-600 outline-none focus:border-primary-500/50 transition-colors"
            />
            <div className="mt-2">
              <label className="block text-[12px] text-surface-500 uppercase tracking-wider font-medium mb-1">
                {t('projectEnglishId')}
              </label>
              <input
                value={npSlug}
                onChange={(e) => handleProjectSlugChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateProject();
                  if (e.key === 'Escape') { setNewProjectOpen(false); resetNewProjectForm(); }
                }}
                placeholder={t('projectSlugPlaceholder')}
                className="w-full bg-surface-800 border border-surface-700 rounded-lg text-[14px] text-gray-200 font-mono px-3 py-2 placeholder-surface-600 outline-none focus:border-primary-500/50 transition-colors"
              />
              <p className="mt-1 text-[12px] text-surface-500">{t('projectSlugHint')}</p>
            </div>
            <div className="flex gap-2 mt-2.5">
              <button
                onClick={() => { setNewProjectOpen(false); resetNewProjectForm(); }}
                className="flex-1 text-[14px] text-gray-400 hover:text-gray-200 py-1.5 rounded-md hover:bg-surface-800 transition-colors"
              >
                {t('common:cancel')}
              </button>
              <button
                onClick={handleCreateProject}
                disabled={!npName.trim() || !isValidProjectSlug(npSlug.trim())}
                className="flex-1 text-[14px] font-medium text-primary-400 py-1.5 rounded-md bg-primary-600/15 hover:bg-primary-600/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {t('common:create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Version History sub-panel */}
      {open && gitOpen && (
        <div className="absolute left-0 top-full mt-2 w-80 md:w-96 max-h-[min(70vh,calc(100dvh-4.5rem))] bg-surface-900 border border-surface-700 rounded-xl shadow-2xl shadow-black/40 overflow-hidden z-[100] flex flex-col">
          <div className="px-3 py-2.5 border-b border-surface-800 flex items-center gap-2">
            <button
              onClick={() => setGitOpen(false)}
              className="p-1.5 hover:bg-surface-800 rounded-lg transition-colors text-gray-400 hover:text-gray-200 active:scale-95"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <svg className="w-3.5 h-3.5 text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-[14px] font-semibold text-gray-300 flex-1">{t('versionHistory')}</span>
            <button
              onClick={() => setOpen(false)}
              className="p-1.5 hover:bg-surface-800 rounded-lg transition-colors text-gray-500 hover:text-gray-300 active:scale-95"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            <GitPanel onViewDiff={(diff) => { onViewDiff?.(diff); setOpen(false); setGitOpen(false); }} />
          </div>
        </div>
      )}

    </div>
  );
}

type TowerIdentityLine = { beforeTower: string; afterTower: string };

function pickRandomIdentityLine(lines: TowerIdentityLine[], previous?: TowerIdentityLine) {
  if (lines.length <= 1) return lines[0];
  let next = lines[Math.floor(Math.random() * lines.length)];
  while (next === previous) {
    next = lines[Math.floor(Math.random() * lines.length)];
  }
  return next;
}

function formatIdentityName(username?: string) {
  if (!username) return '';
  return username.charAt(0).toUpperCase() + username.slice(1);
}

function ActiveSessionDeckControl({ sessionId, projectId, label }: { sessionId: string; projectId: string; label: string | null }) {
  const { t } = useTranslation('layout');
  const sessions = useSessionStore((s) => s.sessions);
  const updateSessionMeta = useSessionStore((s) => s.updateSessionMeta);
  const [open, setOpen] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const labels = React.useMemo(() => [...new Set(sessions.filter((session) => session.projectId === projectId && session.label).map((session) => session.label!))].sort(), [projectId, sessions]);

  React.useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const applyLabel = async (nextLabel: string | null) => {
    if (saving || nextLabel === label) { setOpen(false); return; }
    const previousLabel = label;
    setSaving(true);
    updateSessionMeta(sessionId, { label: nextLabel });
    try {
      const token = localStorage.getItem('token');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(`/api/sessions/${sessionId}`, { method: 'PATCH', headers, body: JSON.stringify({ label: nextLabel }) });
      if (!response.ok) throw new Error('deck assignment failed');
      toastSuccess(nextLabel ? t('sessionAssignedToDeck', { name: nextLabel }) : t('sessionMovedToDefaultDeck'));
      setOpen(false);
      setNewLabel('');
    } catch {
      updateSessionMeta(sessionId, { label: previousLabel });
      toastError(t('deckAssignmentFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-label={t('assignCurrentSessionToDeck')} className="inline-flex max-w-44 items-center gap-1 rounded-md border border-surface-700/70 bg-surface-850 px-2 py-1 text-[12px] font-semibold text-surface-300 hover:border-primary-500/40 hover:text-primary-300">
        <span className="text-surface-500">{t('deck')}</span>
        <span className="truncate">{label || t('defaultDeck')}</span>
        <svg className="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-lg border border-surface-700 bg-surface-850 py-1 shadow-xl">
          <div className="max-h-44 overflow-y-auto">
            <button type="button" disabled={saving} onClick={() => void applyLabel(null)} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-[13px] text-surface-300 hover:bg-surface-700/60"><span>{t('defaultDeck')}</span>{!label && <span className="text-primary-400">✓</span>}</button>
            {labels.map((deckLabel) => <button key={deckLabel} type="button" disabled={saving} onClick={() => void applyLabel(deckLabel)} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-[13px] text-surface-300 hover:bg-surface-700/60"><span className="truncate">{deckLabel}</span>{label === deckLabel && <span className="text-primary-400">✓</span>}</button>)}
          </div>
          <div className="border-t border-surface-700 p-2">
            <div className="flex gap-1.5">
              <input value={newLabel} onChange={(event) => setNewLabel(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && newLabel.trim()) void applyLabel(newLabel.trim()); }} placeholder={t('newDeckPlaceholder')} className="min-w-0 flex-1 rounded border border-surface-700 bg-surface-900 px-2 py-1 text-[12px] text-surface-200 outline-none focus:border-primary-500/50" />
              <button type="button" disabled={!newLabel.trim() || saving} onClick={() => void applyLabel(newLabel.trim())} className="rounded bg-primary-500/15 px-2 text-[12px] font-semibold text-primary-300 disabled:opacity-40">{t('addDeck')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function HeaderImpl({
  connected, onNewSession, onAdminClick, onPersonalCredentialsClick, onPublishClick,
  onViewDiff, onLogout, onSettingsClick, onInboxClick, onSecretariatClick, onSessionFileClick,
  onRequestFileTree, onSelectSession, onNavigateSessions, username, userRole,
}: HeaderProps) {
  const { t, i18n } = useTranslation('layout');
  // Keep App Shell light: subscribe to scalar fields instead of
  // pulling the whole sessions[] array into Header. This prevents high-churn
  // session metadata/stream updates from re-rendering the title-copy path.
  // Decision: workspace/decisions/2026-05-31-realtime-performance-architecture.md
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeSessionName = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions.find((ss) => ss.id === id)?.name ?? null : null;
  });
  const activeSessionProjectId = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions.find((ss) => ss.id === id)?.projectId ?? null : null;
  });
  const activeSessionLabel = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions.find((ss) => ss.id === id)?.label ?? null : null;
  });
  const activeFileTab = useFileStore((s) => {
    const id = s.activeTabId;
    return id ? s.tabs.find((tab) => tab.id === id) ?? null : null;
  });
  const projects = useProjectStore((s) => s.projects);
  const activeProject = React.useMemo(() => {
    if (activeFileTab?.path) {
      return projects
        .filter((project) => project.rootPath && isPathInsideRoot(activeFileTab.path, project.rootPath))
        .sort((a, b) => (b.rootPath || '').length - (a.rootPath || '').length)[0] ?? null;
    }
    return activeSessionProjectId ? projects.find((p) => p.id === activeSessionProjectId) ?? null : null;
  }, [activeFileTab?.path, activeSessionProjectId, projects]);
  const activeAgentName = activeProject?.agent?.displayName || activeProject?.name || null;
  const activeDisplayTitle = activeFileTab?.path
    ? basename(activeFileTab.path)
    : activeSessionName;
  const isMobile = useSessionStore((s) => s.isMobile);
  const identityLines = React.useMemo(
    () => t('towerIdentityLines', { returnObjects: true }) as TowerIdentityLine[],
    [i18n.resolvedLanguage, t],
  );
  const [identityLine, setIdentityLine] = useState(() => pickRandomIdentityLine(identityLines));
  React.useEffect(() => {
    setIdentityLine((current) => pickRandomIdentityLine(identityLines, current));
  }, [identityLines, username]);
  React.useEffect(() => {
    const rotate = window.setInterval(() => {
      setIdentityLine((current) => pickRandomIdentityLine(identityLines, current));
    }, 30 * 60 * 1000);
    return () => window.clearInterval(rotate);
  }, [identityLines]);
  const identityName = React.useMemo(() => formatIdentityName(username) || t('user'), [t, username]);

  return (
    <header className="tower-app-header relative z-50 h-12 bg-surface-900/80 backdrop-blur-md border-b flex items-center px-3 md:px-4 gap-2 md:gap-3 shrink-0">
      {/* ☰ App Menu */}
      <AppMenu
        username={username}
        userRole={userRole}
        onAdminClick={onAdminClick}
        onPersonalCredentialsClick={onPersonalCredentialsClick}
        onPublishClick={onPublishClick}
        onViewDiff={onViewDiff}
        onLogout={onLogout}
        onSettingsClick={onSettingsClick}
        onInboxClick={onInboxClick}
        onSecretariatClick={onSecretariatClick}
        onSessionFileClick={onSessionFileClick}
        onSelectSession={onSelectSession}
        isMobile={isMobile}
      />

      {/* Nav tabs — app-level navigation */}
      {!isMobile && <NavTabs onRequestFileTree={onRequestFileTree} onNavigateSessions={onNavigateSessions} />}

      {/* Active work target — session / file */}
      {activeDisplayTitle && (
        <>
          {!isMobile && <span className="text-surface-700 shrink-0">/</span>}
          <div className="flex min-w-0 flex-[1_1_auto] max-w-[min(82vw,1120px)] items-center gap-3 text-left">
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="shrink-0 text-[12px] font-medium text-surface-500">{t('reference.titleLabel')}:</span>
              <span className="truncate text-[15px] font-bold leading-5 text-surface-100 md:text-[16px]">
                {activeDisplayTitle}
              </span>
            </span>
            {activeAgentName && (
              <span className="hidden min-w-0 items-baseline gap-1.5 sm:flex">
                <span className="shrink-0 text-[12px] font-medium text-surface-500">{t('reference.agentLabel')}:</span>
                <span className="max-w-44 truncate text-[13px] font-semibold text-surface-300">{activeAgentName}</span>
              </span>
            )}
            {!isMobile && !activeFileTab?.path && activeSessionId && activeSessionProjectId && (
              <ActiveSessionDeckControl sessionId={activeSessionId} projectId={activeSessionProjectId} label={activeSessionLabel} />
            )}
          </div>
        </>
      )}

      <div className="flex-1" />

      <div className="flex items-center gap-1.5 md:gap-2 shrink-0">
        {/* Identity statement — right side */}
        <div className="flex items-center mr-1">
          {!isMobile && (
            <span className="text-[15px] text-surface-300 tracking-tight whitespace-nowrap">
              <strong className="font-bold text-gray-100">{identityName}</strong>
              {identityLine.beforeTower}
              <strong className="font-bold text-gray-100">Tower</strong>
              {identityLine.afterTower}
            </span>
          )}
        </div>

        {/* Divider */}
        <div className="w-px h-5 bg-surface-800 shrink-0" />

        {/* Light/Dark toggle */}
        <ThemeToggle />

        <NotificationBell onSelectSession={onSelectSession} />

        {/* Connection indicator */}
        <div className={`w-2 h-2 rounded-full ring-2 ring-surface-900 ring-offset-1 ring-offset-transparent ${connected ? 'tone-success tone-bg' : 'tone-danger tone-bg animate-pulse'}`}
          title={connected ? t('connected') : t('disconnected')}
        />
      </div>
    </header>
  );
}

export const Header = React.memo(HeaderImpl);
