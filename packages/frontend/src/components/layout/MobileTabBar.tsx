import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore, type MobileTab } from '../../stores/session-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useFileStore } from '../../stores/file-store';
import { useProjectStore } from '../../stores/project-store';

const tabIcons: Record<string, React.ReactNode> = {
  chat: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  ),
  files: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
    </svg>
  ),
  work: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 11l2 2 4-4m5-3.5A11.95 11.95 0 0112 3a11.95 11.95 0 01-8 2.5V11c0 5.25 3.4 8.74 8 10 4.6-1.26 8-4.75 8-10V5.5z" />
    </svg>
  ),
  settings: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
};

export function MobileTabBar() {
  const { t } = useTranslation('layout');
  const mobileTab = useSessionStore((s) => s.mobileTab);
  const setMobileTab = useSessionStore((s) => s.setMobileTab);
  const setSidebarOpen = useSessionStore((s) => s.setSidebarOpen);
  const setSidebarTab = useSessionStore((s) => s.setSidebarTab);
  const setMobileContextOpen = useSessionStore((s) => s.setMobileContextOpen);
  const setMobileFilesNavigationSurface = useSessionStore((s) => s.setMobileFilesNavigationSurface);
  const setAiNavigationSurface = useSessionStore((s) => s.setAiNavigationSurface);
  const openSettings = useSettingsStore((s) => s.setOpen);
  const setActiveView = useSessionStore((s) => s.setActiveView);
  const agentFirstEnabled = useSettingsStore((s) => s.serverConfig?.agentFirstEnabled === true);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const projects = useProjectStore((s) => s.projects);
  const capabilityProjectId = useSettingsStore((s) => s.capabilityProjectId);
  const setCapabilityProjectId = useSettingsStore((s) => s.setCapabilityProjectId);

  const tabs: { id: MobileTab | 'settings'; label: string; icon: React.ReactNode; badge?: number }[] = agentFirstEnabled
    ? [
        { id: 'ai', label: t('aiTeamNav'), icon: tabIcons.chat },
        { id: 'files', label: t('files'), icon: tabIcons.files },
        { id: 'settings', label: t('settings'), icon: tabIcons.settings },
      ]
    : [
        { id: 'ai', label: t('aiTeam'), icon: tabIcons.chat },
        { id: 'files', label: t('files'), icon: tabIcons.files },
        { id: 'settings', label: t('settings'), icon: tabIcons.settings },
      ];

  const visibleTabs = tabs;

  const handleTabClick = (tab: MobileTab | 'settings') => {
    if (tab === 'settings') {
      openSettings(true);
      return;
    }
    setMobileTab(tab);
    if (tab === 'ai') {
      setAiNavigationSurface();
      setSidebarOpen(true);
      setMobileContextOpen(false);
    } else if (tab === 'files') {
      const activeSessionProjectId = sessions.find((session) => session.id === activeSessionId)?.projectId || null;
      const selectedProjectId = activeSessionProjectId || capabilityProjectId;
      const selectedProject = projects.find((project) => project.id === selectedProjectId && !project.archived)
        || projects.find((project) => project.rootPath && !project.archived)
        || null;

      useFileStore.getState().activateChatSlot();

      // Commit the Files route atomically. Separate Zustand writes allowed the
      // drawer to render the previous AI Team tab for one frame (or longer when
      // project hydration completed between writes).
      if (selectedProject) setCapabilityProjectId(selectedProject.id);
      setMobileFilesNavigationSurface();
    }
  };

  return (
    <nav className="tower-mobile-tab-bar bg-surface-900 border-t border-surface-800 shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
      <div className="h-16 flex items-stretch">
      {visibleTabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => handleTabClick(tab.id)}
          className={`relative flex-1 flex flex-col items-center justify-center gap-1 transition-colors ${
            tab.id !== 'settings' && mobileTab === tab.id
              ? 'text-primary-400'
              : 'text-gray-500 active:text-gray-300'
          }`}
        >
          <span className="relative">
            {tab.icon}
            {tab.badge != null && tab.badge > 0 && mobileTab !== tab.id && (
              <span className="absolute -right-2 -top-1.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-red-500 px-0.5 text-[10px] font-bold leading-none text-white">
                {tab.badge > 99 ? '99+' : tab.badge}
              </span>
            )}
          </span>
          <span className="text-[13px] font-medium">{tab.label}</span>
        </button>
      ))}
      </div>
    </nav>
  );
}
