import React from 'react';
import { useTranslation } from 'react-i18next';
import { type AgentCareerLevel, type Project, type SessionMeta } from '@tower/shared';
import { isPureAgentSession } from '../../features/agent-sessions/classification';
import { AgentIdentityAvatar } from '../../features/agent-profile/AgentIdentityAvatar';

interface AITeamHomeProps {
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

export function AITeamHome({ projects, sessions, activeSessionId, onSelectSession, onNewSession, onOpenProjectHome }: AITeamHomeProps) {
  const { t, i18n } = useTranslation('layout');
  const rootRef = React.useRef<HTMLElement>(null);
  const [filter, setFilter] = React.useState<DirectoryFilter>('all');
  const [sort, setSort] = React.useState<DirectorySort>('name');

  React.useLayoutEffect(() => {
    rootRef.current?.closest<HTMLElement>('[data-ai-team-scroll]')?.scrollTo({ top: 0 });
  }, []);

  const helper = projects.find((project) => project.systemKey === 'ai-talent-team');
  const teammates = projects.filter((project) => project.agent?.explicit === true && project.systemKey !== 'ai-talent-team' && !project.archived);
  const startCreator = () => window.dispatchEvent(new CustomEvent('tower-start-agent-academy'));
  const levelTitle = (level: AgentCareerLevel) => level === 'intern' ? t('careerIntern') : level === 'practitioner' ? t('careerPractitioner') : level === 'manager' ? t('careerManager') : t('careerPartner');

  const directory = React.useMemo(() => teammates.map((project) => {
    const recent = latestConversation(project.id, sessions);
    return { project, recent, active: isRecentlyActive(recent) };
  }), [teammates, sessions]);

  const visible = directory
    .filter((item) => filter === 'all' || (filter === 'active' ? item.active : !item.active))
    .sort((a, b) => sort === 'name'
      ? (a.project.agent?.displayName || a.project.name).localeCompare(b.project.agent?.displayName || b.project.name, i18n.language)
      : new Date(b.project.createdAt || 0).getTime() - new Date(a.project.createdAt || 0).getTime());

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
          <button type="button" data-tour-id="agent-create" onClick={startCreator} className="ai-team-primary-action w-full shrink-0 rounded-xl px-4 py-3 text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/70 sm:w-auto">
            {t('newAiTeammate')}
          </button>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-surface-800/80 pt-4 text-xs text-surface-500">
          <span>{t('aiTeammateCount')} <strong className="ml-1 text-surface-200">{teammates.length}</strong></span>
          <span>{t('availableTeammates')} <strong className="ml-1 text-surface-200">{directory.filter((item) => item.active).length}</strong></span>
          <span>{t('inactiveTeammates')} <strong className="ml-1 text-surface-200">{directory.filter((item) => !item.active).length}</strong></span>
        </div>
      </header>

      <div className="mt-5 flex flex-wrap items-center gap-1.5">
        {(['all', 'active', 'inactive'] as const).map((value) => (
          <button key={value} type="button" onClick={() => setFilter(value)} className={`rounded-full px-3 py-1.5 text-xs font-semibold ${filter === value ? 'bg-primary-500/15 text-primary-300' : 'text-surface-500 hover:bg-surface-800'}`}>
            {t(`teammateFilter.${value}`)}
          </button>
        ))}
        <select value={sort} onChange={(event) => setSort(event.target.value as DirectorySort)} className="ml-auto rounded-lg border border-surface-800 bg-surface-900 px-2.5 py-1.5 text-xs text-surface-400" aria-label={t('sortAiTeammates')}>
          <option value="name">{t('sortName')}</option>
          <option value="created">{t('sortRecentlyCreated')}</option>
        </select>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label={t('aiTeammateList')}>
        {teammates.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-surface-700 p-5 text-center">
            <div className="text-sm font-semibold text-surface-300">{t('noAiTeammates')}</div>
            <p className="mt-1 text-xs leading-5 text-surface-600">{t('noAiTeammatesDescription')}</p>
          </div>
        ) : visible.map(({ project, recent, active }) => {
          const agent = project.agent;
          const displayName = agent?.displayName?.trim() || project.name;
          const description = agent?.tagline?.trim() || agent?.role?.trim() || project.description?.trim() || t('teammateFallbackDescription', { name: project.name });
          const level = (agent?.careerLevel || 'intern') as AgentCareerLevel;
          return (
            <article key={project.id} className={`ai-team-member-card flex min-h-52 min-w-0 flex-col rounded-2xl border p-4 ${recent?.id === activeSessionId ? 'is-active' : ''}`}>
              <div className="flex min-w-0 items-start gap-3">
                <AgentIdentityAvatar project={project} className="h-12 w-12 shrink-0 rounded-xl border border-primary-400/20" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <h3 className="min-w-0 flex-1 truncate text-sm font-bold text-surface-100">{displayName}</h3>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${active ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300' : 'border-surface-700 bg-surface-800 text-surface-500'}`}>{active ? t('teammateStatus.available') : t('teammateStatus.inactive')}</span>
                  </div>
                  <p className="mt-1 line-clamp-3 text-[11px] leading-5 text-surface-500">{description}</p>
                </div>
              </div>

              <dl className="mt-4 divide-y divide-surface-800 border-y border-surface-800 text-[11px]">
                <div className="flex items-center justify-between gap-3 py-2"><dt className="text-surface-600">{t('teammateRole')}</dt><dd className="truncate font-medium text-surface-300">{levelTitle(level)}</dd></div>
                <div className="flex items-center justify-between gap-3 py-2"><dt className="text-surface-600">{t('workspace')}</dt><dd className="truncate font-medium text-surface-300">{project.name}</dd></div>
                <div className="flex items-center justify-between gap-3 py-2"><dt className="text-surface-600">{t('teammateInstruction')}</dt><dd className="truncate font-medium text-surface-300">{agent?.role?.trim() || t('teammateInstructionConfigured')}</dd></div>
              </dl>

              <div className="mt-auto flex items-center gap-2 pt-4">
                <button type="button" onClick={() => onOpenProjectHome(project)} className="tone-accent tone-action flex-1 rounded-lg border px-3 py-2.5 text-xs font-bold transition-colors">{t('manageTeammate')}</button>
                <button type="button" onClick={() => onNewSession(project.id)} className="flex-1 rounded-lg border border-surface-700 px-3 py-2.5 text-xs font-semibold text-surface-300 transition-colors hover:border-primary-500/40 hover:text-primary-300">{t('startConversation')}</button>
                {recent && <button type="button" onClick={() => onSelectSession(recent)} className="sr-only">{t('recentConversation')}</button>}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
