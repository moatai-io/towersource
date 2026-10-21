import { TeamDashboardControl } from '../interactive-apps/TeamDashboardControl';
import React from 'react';
import { TeamManagementPanel } from './TeamManagementPanel';
import { TeamConnections } from '../../features/team-connections/TeamConnections';
import { useAgentDirectoryCards } from '../../features/agent-directory/useAgentDirectoryCards';
import { AgentCharacterAvatar, distributedKoreanCharacterId } from '../../features/agent-profile/characters';
import { VisualAgentTeams } from './VisualAgentTeams';
import { useTranslation } from 'react-i18next';
import { type AgentCareerLevel, type Project, type SessionMeta } from '@tower/shared';
import { isPureAgentSession } from '../../features/agent-sessions/classification';
import { AgentIdentityAvatar } from '../../features/agent-profile/AgentIdentityAvatar';

interface AITeamHomeProps {
  isAdmin?: boolean;
  onClose: () => void;
  projects: Project[];
  sessions: SessionMeta[];
  activeSessionId: string | null;
  onSelectSession: (session: SessionMeta) => void;
  onNewSession: (projectId: string) => void;
  onOpenProjectHome: (project: Project) => void;
}

type DirectoryFilter = 'all' | 'active' | 'inactive';
type DirectorySort = 'name' | 'created';

function latestConversation(projectId: string, sessions: SessionMeta[]): SessionMeta | null {
  return sessions
    .filter((session) => session.projectId === projectId && !isPureAgentSession(session))
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime())[0] || null;
}

function isRecentlyActive(session: SessionMeta | null): boolean {
  if (!session) return false;
  return new Date(session.updatedAt || session.createdAt || 0).getTime() > Date.now() - 14 * 864e5;
}

export function AITeamHome({ isAdmin = false, onClose, projects, sessions, activeSessionId, onSelectSession, onNewSession, onOpenProjectHome }: AITeamHomeProps) {
  const { t, i18n } = useTranslation('layout');
  const rootRef = React.useRef<HTMLElement>(null);
  const [filter, setFilter] = React.useState<DirectoryFilter>('all');
  const [sort, setSort] = React.useState<DirectorySort>('name');
  const [query, setQuery] = React.useState('');
  const [showTeamManagement, setShowTeamManagement] = React.useState(false);
  const [remoteMatches, setRemoteMatches] = React.useState<Project[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [view, setView] = React.useState<'directory' | 'teams' | 'control'>('directory');
  const discovery = useAgentDirectoryCards(onOpenProjectHome, isAdmin);

  React.useLayoutEffect(() => {
    rootRef.current?.closest<HTMLElement>('[data-ai-team-scroll]')?.scrollTo({ top: 0 });
  }, []);

  const helper = projects.find((project) => project.systemKey === 'ai-talent-team');
  // Every active non-system Project is a Primary Agent workcell, including
  // legacy Projects whose Agent profile is still implicit.
  const teammates = projects.filter((project) => !project.systemKey && !project.archived);
  const normalizedQuery = query.trim().toLocaleLowerCase(i18n.language);

  React.useEffect(() => {
    if (normalizedQuery.length < 2) {
      setRemoteMatches([]);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const token = localStorage.getItem('token');
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
        const response = await fetch(`/api/projects/search?q=${encodeURIComponent(query.trim())}`, { headers, signal: controller.signal });
        const data = await response.json();
        if (response.ok) setRemoteMatches(Array.isArray(data.projects) ? data.projects : []);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setRemoteMatches([]);
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 180);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [normalizedQuery, query]);
  // Search is also the recovery path for legacy and archived Agents that are
  // intentionally absent from the quiet default directory.
  const startCreator = () => window.dispatchEvent(new CustomEvent('tower-start-agent-academy'));
  const levelTitle = (level: AgentCareerLevel) => level === 'intern' ? t('careerIntern') : level === 'practitioner' ? t('careerPractitioner') : level === 'manager' ? t('careerManager') : t('careerPartner');

  const projectCards = (normalizedQuery ? [...new Map([...projects, ...remoteMatches].filter(project => !project.systemKey).map(project => [project.id, project])).values()] : teammates).map((project) => {
    const recent = latestConversation(project.id, sessions);
    return {
      project, discovery: null, recent,
      name: project.agent?.displayName || project.name,
      role: project.agent?.tagline || project.agent?.role || project.description || t('primaryAgentRole'),
      active: isRecentlyActive(recent),
      conversationCount: project.sessionCount ?? 0,
      completedWorkCount: project.careerMetrics?.completedWorkstreams ?? 0,
    };
  });
  // One union owns search, sort, counts and empty states for both kinds of cards.
  const allProjectIds = new Set([...projects, ...remoteMatches].map(project => project.id));
  const discoveryCards = discovery.agents.filter(agent => !allProjectIds.has(agent.projectId)).map(agent => ({
    project: null, discovery: agent, recent: null, name: agent.name,
    role: agent.shortRole, conversationCount: 0, completedWorkCount: 0, active: false,
  }));
  const directory = [...projectCards, ...discoveryCards];
  const visible = directory
    .filter(item => !normalizedQuery || [item.name, item.role, item.project?.description, item.project?.agent?.role].some(value => value?.toLocaleLowerCase(i18n.language).includes(normalizedQuery)))
    .filter((item) => filter === 'all' || (filter === 'active' ? item.active : !item.active))
    .sort((a, b) => sort === 'name'
      ? a.name.localeCompare(b.name, i18n.language)
      : new Date(b.project?.createdAt || 0).getTime() - new Date(a.project?.createdAt || 0).getTime());

  return (
    <section ref={rootRef} aria-labelledby="ai-team-home-title" className="ai-team-control-room agent-product-surface min-w-0 pb-8 [word-break:keep-all] [overflow-wrap:break-word]">
      <header className="ai-team-hero overflow-hidden rounded-3xl border p-5 sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="tone-accent tone-text text-[10px] font-bold uppercase tracking-[0.18em]">AI TEAM</div>
            <h2 id="ai-team-home-title" className="mt-1 text-2xl font-bold tracking-tight text-surface-100">{t('aiTeammateManagement')}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-surface-500">{t('aiTeammateManagementDescription')}</p>
            {helper && <button type="button" onClick={() => onNewSession(helper.id)} className="mt-3 text-left text-xs font-semibold text-surface-500 transition-colors hover:text-primary-300">{t('aiTeamHelper')}</button>}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button type="button" data-tour-id="agent-create" onClick={startCreator} className="ai-team-primary-action w-full rounded-xl px-4 py-3 text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/70 sm:w-auto">
              {t('newAiTeammate')}
            </button>
            <button type="button" onClick={onClose} aria-label={t('closeAiTeam')} title={t('closeAiTeam')} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-surface-700 px-3 py-2.5 text-sm text-surface-200 transition-colors hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
              {t('returnToChat')}
            </button>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-surface-800/80 pt-4 text-xs text-surface-500">
          <span>{t('aiTeammateCount')} <strong className="ml-1 text-surface-200">{directory.length}</strong></span>
          <span>{t('availableTeammates')} <strong className="ml-1 text-surface-200">{directory.filter((item) => item.active).length}</strong></span>
          <span>{t('inactiveTeammates')} <strong className="ml-1 text-surface-200">{directory.filter((item) => !item.active).length}</strong></span>
        </div>
      </header>

      {isAdmin && <section className="mt-4">
        <button type="button" aria-expanded={showTeamManagement} onClick={() => setShowTeamManagement(value => !value)} className="rounded-lg border border-surface-700 px-4 py-2 text-sm text-surface-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">
          {t('aiTeamGrouping.permissionTeams', { defaultValue: '권한 팀 관리' })}
        </button>
        {showTeamManagement && <TeamManagementPanel projects={teammates} />}
      </section>}

      <TeamConnections projects={projects} onOpenProject={onOpenProjectHome} />
      <div className="mt-5 flex gap-2" role="tablist" aria-label={t('aiTeamGrouping.views', { defaultValue: '에이전트 보기' })}>
        <button type="button" role="tab" id="agent-directory-tab" aria-selected={view === 'directory'} aria-controls="agent-directory-panel" onClick={() => setView('directory')} className="rounded-lg border border-surface-700 px-4 py-2 text-sm text-surface-300 aria-selected:border-primary-400 aria-selected:text-primary-300">{t('aiTeamGrouping.directoryView', { defaultValue: '에이전트 목록' })}</button>
        <button type="button" role="tab" id="visual-agent-teams-tab" aria-selected={view === 'teams'} aria-controls="visual-agent-teams-panel" onClick={() => setView('teams')} className="rounded-lg border border-surface-700 px-4 py-2 text-sm text-surface-300 aria-selected:border-primary-400 aria-selected:text-primary-300">{t('aiTeamGrouping.visualTeamView', { defaultValue: '시각적 팀 보기' })}</button>
        <button type="button" role="tab" id="team-control-tab" aria-selected={view === 'control'} aria-controls="team-control-panel" onClick={() => setView('control')} className="rounded-lg border border-surface-700 px-4 py-2 text-sm text-surface-300 aria-selected:border-primary-400 aria-selected:text-primary-300">{t('teamControl.title')}</button>
      </div>
      {view === 'control' ? <div id="team-control-panel" role="tabpanel" aria-labelledby="team-control-tab" className="mt-5"><TeamDashboardControl projects={projects} /></div> : view === 'teams' ? <div id="visual-agent-teams-panel" role="tabpanel" aria-labelledby="visual-agent-teams-tab"><VisualAgentTeams projects={teammates} /></div> : <div id="agent-directory-panel" role="tabpanel" aria-labelledby="agent-directory-tab">
      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="relative min-w-0 flex-1 sm:max-w-md">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-surface-600" aria-hidden="true">⌕</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('searchAiTeammates')}
            aria-label={t('searchAiTeammates')}
            className="h-10 w-full rounded-xl border border-surface-800 bg-surface-900 pl-9 pr-9 text-sm text-surface-200 outline-none placeholder:text-surface-600 focus:border-primary-500/60"
          />
          {query && <button type="button" onClick={() => setQuery('')} aria-label={t('clearAiTeammateSearch')} className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-surface-600 hover:bg-surface-800 hover:text-surface-200">×</button>}
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
        {(['all', 'active', 'inactive'] as const).map((value) => (
          <button key={value} type="button" onClick={() => setFilter(value)} className={`rounded-full px-3 py-1.5 text-xs font-semibold ${filter === value ? 'bg-primary-500/15 text-primary-300' : 'text-surface-500 hover:bg-surface-800'}`}>
            {t(`teammateFilter.${value}`)}
          </button>
        ))}
        <select value={sort} onChange={(event) => setSort(event.target.value as DirectorySort)} className="ml-auto rounded-lg border border-surface-800 bg-surface-900 px-2.5 py-1.5 text-xs text-surface-500" aria-label={t('sortAiTeammates')}>
          <option value="name">{t('sortName')}</option>
          <option value="created">{t('sortRecentlyCreated')}</option>
        </select>
        </div>
      </div>

      {discovery.status === 'loading' && <p role="status" className="mt-3 text-sm text-surface-500">{t('agentDirectory.loading')}</p>}
      {discovery.status === 'error' && <p role="alert" className="mt-3 text-sm text-red-300">{t('agentDirectory.error')} <button type="button" onClick={discovery.refresh}>{t('agentDirectory.refresh')}</button></p>}
      {discovery.participationUnavailable && <p role="status" className="mt-3 text-sm text-surface-500">{t('aiTeamGrouping.participationUnavailable', { defaultValue: '관리자·운영자 참여 목록을 불러오지 못했습니다. 담당자 안내를 이용하거나 다시 시도해 주세요.' })} <button type="button" onClick={discovery.refresh}>{t('agentDirectory.refresh')}</button></p>}
      {discovery.entryError && <p role="alert" className="mt-3 text-sm text-red-300">{t('agentDirectory.entryError')}</p>}
      {normalizedQuery && <p className="mt-3 text-xs text-surface-500">{searching ? t('searchingAiTeammates') : t('aiTeammateSearchSummary', { query: query.trim(), count: visible.length })}</p>}

      <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-2.5" aria-label={t('aiTeammateList')}>
        {visible.length === 0 && !searching && discovery.status === 'ready' && (
          <div className="rounded-2xl border border-dashed border-surface-700 p-5 text-center sm:col-span-2 xl:col-span-3">
            <div className="text-sm font-semibold text-surface-300">{t(normalizedQuery ? 'noAiTeammateSearchResults' : 'noAiTeammates')}</div>
            <p className="mt-1 text-xs leading-5 text-surface-600">{t(normalizedQuery ? 'noAiTeammateSearchResultsDescription' : 'noAiTeammatesDescription', { query: query.trim() })}</p>
          </div>
        )}
        {visible.map(({ project, discovery: discoveredAgent, recent, active, conversationCount, completedWorkCount }) => {
          if (!project && discoveredAgent) {
            const joinable = discovery.joinable.has(discoveredAgent.projectId);
            return <article key={discoveredAgent.projectId} className="ai-team-agent-card rounded-2xl border border-surface-700 p-4 sm:p-5">
              <div className="flex items-start gap-3">
                <AgentCharacterAvatar id={distributedKoreanCharacterId(discoveredAgent.projectId)} variant="list" showListAccent={false} className="h-[84px] w-[84px] shrink-0" />
                <div className="min-w-0 flex-1">
                  <h2 className="break-words text-base font-bold text-surface-100">{discoveredAgent.name}</h2>
                  <p className="mt-1 text-xs leading-5 text-surface-500">{discoveredAgent.shortRole || t('primaryAgentRole')}</p>
                  <p className="mt-2 text-xs text-surface-500">{t(joinable ? 'aiTeamGrouping.participationAvailable' : `agentDirectory.access.${discoveredAgent.access}`, { defaultValue: joinable ? '관리자·운영자 참여 가능' : undefined })}</p>
                </div>
              </div>
              <div className="mt-4 border-t border-surface-800/70 pt-3">
                <button type="button" disabled={discovery.opening !== null} onClick={() => void discovery.open(discoveredAgent, {
                  title: t('aiTeamGrouping.joinTitle', { defaultValue: '에이전트 참여' }),
                  message: t('aiTeamGrouping.joinConfirm', { defaultValue: '공유 대화와 파일에 접근하는 일반 구성원으로 참여합니다. 소유자에게 참여 사실이 알려집니다. 참여할까요?' }),
                  confirmText: t('aiTeamGrouping.join', { defaultValue: '참여하기' }),
                })} className="rounded-lg border border-primary-400/30 px-3 py-2 text-xs font-semibold text-primary-300 disabled:opacity-50">
                  {discovery.opening === discoveredAgent.projectId ? t('aiTeamGrouping.opening', { defaultValue: '입장 중…' }) : joinable ? t('aiTeamGrouping.join', { defaultValue: '참여하기' }) : t(discoveredAgent.access === 'contact' ? 'agentDirectory.introduction' : 'aiTeamGrouping.enter')}
                </button>
                {discovery.contact === discoveredAgent.projectId && <p role="status" className="mt-3 text-sm text-surface-300">{t('agentDirectory.askContact', { name: discoveredAgent.contactName || t('agentDirectory.noContact') })}</p>}
              </div>
            </article>;
          }
          if (!project) return null;
          const agent = project.agent;
          const displayName = agent?.displayName?.trim() || project.name;
          const role = agent?.role?.trim() || agent?.tagline?.trim() || project.description?.trim() || t('teammateFallbackDescription', { name: project.name });
          const level = (agent?.careerLevel || 'intern') as AgentCareerLevel;
          return (
            <article key={project.id} className={`ai-team-member-card group flex min-w-0 flex-col rounded-xl border p-2.5 ${recent?.id === activeSessionId ? 'is-active' : ''}`}>
              <div className="flex min-w-0 items-start gap-2.5">
                <button type="button" onClick={() => onOpenProjectHome(project)} className="shrink-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/70" aria-label={t('openTeammateHome', { name: displayName })}>
                  <AgentIdentityAvatar project={project} className="h-20 w-20 shrink-0" />
                </button>
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <h3 className="min-w-0 flex-1 truncate text-sm font-bold text-surface-100">{displayName}</h3>
                    <span className={`h-2 w-2 shrink-0 rounded-full ${active ? 'bg-emerald-400' : 'bg-surface-600'}`} title={active ? t('teammateStatus.available') : t('teammateStatus.inactive')} />
                  </div>
                  <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] font-semibold text-surface-500">
                    <span className="shrink-0 rounded border border-surface-700 px-1.5 py-0.5">{levelTitle(level)}</span>
                    {project.archived
                      ? <span className="truncate text-amber-300">{t('archivedTeammate')}</span>
                      : !agent?.explicit
                        ? <span className="truncate">{t('legacyTeammate')}</span>
                        : null}
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-[10px] leading-4 text-surface-500" title={role}>{role}</p>
                </div>
              </div>

              <div className="mt-2 flex items-center gap-2 border-y border-surface-800 py-1.5 text-[10px] text-surface-600">
                <span>{t('totalConversations')} <strong className="ml-0.5 font-semibold tabular-nums text-surface-300">{conversationCount}</strong></span>
                <span aria-hidden="true" className="text-surface-700">·</span>
                <span>{t('completedWork')} <strong className="ml-0.5 font-semibold tabular-nums text-surface-300">{completedWorkCount}</strong></span>
              </div>

              <dl className="mt-1.5 space-y-0.5 text-[10px] leading-4">
                <div className="flex min-w-0 gap-2"><dt className="w-12 shrink-0 text-surface-600">{t('workspace')}</dt><dd className="truncate font-medium text-surface-300">{project.name}</dd></div>
                <div className="flex min-w-0 gap-2"><dt className="w-12 shrink-0 text-surface-600">{t('teammateInstruction')}</dt><dd className="truncate font-medium text-surface-300" title={role}>{role}</dd></div>
              </dl>

              <div className="mt-2 flex items-center gap-1.5 border-t border-surface-800 pt-2">
                <button type="button" onClick={() => onOpenProjectHome(project)} className="tone-accent tone-action flex-1 rounded-md border px-2 py-1.5 text-[11px] font-bold transition-colors">{t('manageTeammate')}</button>
                <button type="button" onClick={() => onNewSession(project.id)} className="flex-1 rounded-md border border-surface-700 px-2 py-1.5 text-[11px] font-semibold text-surface-300 transition-colors hover:border-primary-500/40 hover:text-primary-300">{t('startConversation')}</button>
                {recent && <button type="button" onClick={() => onSelectSession(recent)} className="sr-only">{t('recentConversation')}</button>}
              </div>
            </article>
          );
        })}
      </div>
      </div>}
    </section>
  );
}
