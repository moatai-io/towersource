import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project } from '../../stores/project-store';
import type { SessionMeta } from '../../stores/session-store';
import { AgentIdentityAvatar } from '../../features/agent-profile/AgentIdentityAvatar';
import { FadeOverflowText } from '../common/FadeOverflowText';

type AgentNavScope = 'team' | 'work';

interface AgentNavigationRailProps {
  expanded: boolean;
  width: number;
  isResizing: boolean;
  scope: AgentNavScope;
  selectedProjectId: string | null;
  contextualProjectId: string | null;
  projects: Array<{ project: Project; sessions: SessionMeta[] }>;
  previousAgents?: Array<{ id: string; name: string }>;
  streamingSessionIds: Set<string>;
  onToggleExpanded: () => void;
  onOpenRecent: () => void;
  onOpenTeam: () => void;
  onSelectProject: (projectId: string) => void;
  onOpenProjectMenu: (event: React.MouseEvent, projectId: string) => void;
  onCreateAgent: () => void;
  onResizeStart: (event: React.PointerEvent<HTMLElement>) => void;
}

export function AgentNavigationRail({
  expanded,
  width,
  isResizing,
  scope,
  selectedProjectId,
  contextualProjectId,
  projects,
  previousAgents = [],
  streamingSessionIds,
  onToggleExpanded,
  onOpenRecent,
  onOpenTeam,
  onSelectProject,
  onOpenProjectMenu,
  onCreateAgent,
  onResizeStart,
}: AgentNavigationRailProps) {
  const { t } = useTranslation('layout');
  const [hoverExpanded, setHoverExpanded] = useState(false);
  const visuallyExpanded = expanded || hoverExpanded;
  const labelVisibility = visuallyExpanded ? 'opacity-100' : 'opacity-0';

  return (
    <nav
      className={`agent-nav-rail tower-sidebar-primary relative hidden h-full min-h-0 shrink-0 flex-col overflow-hidden bg-surface-900/95 px-2 py-2 motion-reduce:transition-none min-[769px]:flex ${isResizing ? 'transition-none' : 'transition-[width,margin-right] duration-200 ease-out'} ${visuallyExpanded ? 'is-expanded' : ''} ${!expanded && hoverExpanded ? 'z-30 shadow-xl' : ''}`}
      style={{ width: visuallyExpanded ? width : 56, marginRight: !expanded && hoverExpanded ? -(width - 56) : 0 }}
      onMouseEnter={() => setHoverExpanded(true)}
      onMouseLeave={() => setHoverExpanded(false)}
      onFocus={() => setHoverExpanded(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setHoverExpanded(false); }}
      onKeyDown={(event) => { if (event.key === 'Escape') setHoverExpanded(false); }}
      aria-label={t('agentNavigation')}
    >
      <button
        type="button"
        onClick={onToggleExpanded}
        className="mb-1 flex h-8 w-10 shrink-0 items-center justify-center rounded-md text-surface-600 transition-colors hover:bg-surface-800 hover:text-surface-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/70"
        aria-label={expanded ? t('collapseAiNameList') : t('expandAiNameList')}
        title={expanded ? t('collapseAiNameList') : t('expandAiNameList')}
        aria-expanded={expanded}
      >
        <svg className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="m9 5 7 7-7 7" /></svg>
      </button>
      <div className="w-full shrink-0">
        <button
          type="button"
          onClick={onOpenRecent}
          className={`flex h-9 w-full shrink-0 items-center rounded-xl text-[11px] font-bold transition-colors ${scope === 'work' && selectedProjectId === null ? 'bg-primary-500/15 text-primary-700 ring-1 ring-primary-500/30 dark:text-primary-200' : 'text-surface-500 hover:bg-surface-800 hover:text-surface-200'}`}
          aria-label={t('openRecentConversations')}
          title={t('conversationsNavTitle')}
          aria-pressed={scope === 'work' && selectedProjectId === null}
        >
          <span className="grid h-9 w-10 shrink-0 place-items-center"><svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M12 7.25V12l3 1.75M4.75 8.5H2.5V6.25M3.2 8.1A9 9 0 1 1 3 15.5" /></svg></span>
          <span className={`min-w-0 flex-1 truncate text-left text-[13px] font-semibold transition-opacity duration-150 motion-reduce:transition-none ${labelVisibility}`}>{t('recentConversationsNav')}</span>
        </button>
        <button
          type="button"
          onClick={onOpenTeam}
          className={`mt-1 flex h-9 w-full shrink-0 items-center rounded-xl text-[11px] font-bold transition-colors ${scope === 'team' && selectedProjectId === null ? 'bg-primary-500/15 text-primary-700 ring-1 ring-primary-500/30 dark:text-primary-200' : 'text-surface-500 hover:bg-surface-800 hover:text-surface-200'}`}
          aria-label={t('openAiTeamHome')}
          title={t('aiTeammateManagementTitle')}
          aria-pressed={scope === 'team' && selectedProjectId === null}
        >
          <span className="grid h-9 w-10 shrink-0 place-items-center"><svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M4 19.5V8.25L12 3l8 5.25V19.5M8 19.5v-5h8v5" /></svg></span>
          <span className={`min-w-0 flex-1 truncate text-left text-[13px] font-semibold transition-opacity duration-150 motion-reduce:transition-none ${labelVisibility}`}>{t('aiTeammateManagement')}</span>
        </button>
        <div className={`mt-2 h-px bg-surface-800 transition-[width] duration-200 motion-reduce:transition-none ${visuallyExpanded ? 'w-full' : 'ml-1.5 w-7'}`} />
      </div>
      <div className="scrollbar-none min-h-0 w-full flex-1 overflow-y-auto overflow-x-hidden pt-2 [mask-image:linear-gradient(to_bottom,transparent_0,black_10px,black_calc(100%-10px),transparent_100%)]">
        {projects.map(({ project, sessions }) => {
          const selected = selectedProjectId === project.id;
          const contextual = !selected && contextualProjectId === project.id;
          const running = sessions.some((session) => streamingSessionIds.has(session.id));
          return (
            <button
              key={project.id}
              type="button"
              onClick={() => onSelectProject(project.id)}
              onContextMenu={(event) => onOpenProjectMenu(event, project.id)}
              className={`relative flex h-10 w-full shrink-0 items-center rounded-lg transition-colors ${selected ? 'bg-primary-500/10' : contextual ? 'bg-primary-500/[0.045]' : 'hover:bg-surface-800/80'}`}
              aria-label={t('openAiConversations', { name: project.agent?.displayName || project.name })}
              title={project.agent?.displayName || project.name}
              aria-pressed={selected}
              aria-current={selected ? 'page' : undefined}
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center"><AgentIdentityAvatar project={project} variant="list" showListAccent={false} className="h-7 w-7 shrink-0 rounded-lg" fallbackClassName="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface-800 text-[11px]" /></span>
              <FadeOverflowText className={`min-w-0 flex-1 overflow-hidden whitespace-nowrap text-left text-[13px] font-medium transition-opacity duration-150 motion-reduce:transition-none ${selected ? 'text-primary-700 dark:text-primary-200' : contextual ? 'text-surface-100' : 'text-surface-300'} ${labelVisibility}`}>{project.agent?.displayName || project.name}</FadeOverflowText>
              {running && <span className="sr-only">{t('agentRunning')}</span>}
            </button>
          );
        })}
        {previousAgents.length > 0 && <section aria-label={t('previousParticipation')} className="mt-3 border-t border-white/10 pt-2">
          {visuallyExpanded && <div className="px-2 py-1 text-xs text-gray-500">{t('previousParticipation')}</div>}
          {previousAgents.map((agent) => <div key={agent.id} title={`${agent.name} · ${t('notParticipating')} — ${t('previousParticipationHint')}`} className="px-2 py-2 text-gray-500">
            <span className="block truncate text-sm">{visuallyExpanded ? agent.name : agent.name.slice(0, 1)}</span>
            {visuallyExpanded && <span className="text-xs">{t('notParticipating')}</span>}
          </div>)}
          {visuallyExpanded && <p className="px-2 py-1 text-xs text-gray-500">{t('previousParticipationHint')}</p>}
        </section>}
        <button
          type="button"
          data-tour-id="agent-rail-create"
          onClick={onCreateAgent}
          className="mt-2 flex h-10 w-full shrink-0 items-center rounded-xl border border-dashed border-primary-500/30 text-primary-300 transition-colors hover:border-primary-500/55 hover:bg-primary-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/70"
          aria-label={t('newAiTeammate')}
          title={t('newAiTeammate')}
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center text-lg" aria-hidden="true">+</span>
          <span className={`min-w-0 flex-1 truncate text-left text-[13px] font-semibold transition-opacity duration-150 motion-reduce:transition-none ${labelVisibility}`}>{t('newAiTeammate')}</span>
        </button>
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('resizeSidebar')}
        className="group absolute inset-y-0 right-0 z-20 w-3 translate-x-1/2 cursor-col-resize touch-none"
        onPointerDown={onResizeStart}
      >
        <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--th-border-subtle)] transition-colors group-hover:bg-[var(--th-border)]" />
      </div>

    </nav>
  );
}
