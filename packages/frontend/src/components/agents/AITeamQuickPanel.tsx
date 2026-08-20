import React from 'react';
import { useTranslation } from 'react-i18next';
import type { Project, SessionMeta } from '@tower/shared';
import { AgentIdentityAvatar } from '../../features/agent-profile/AgentIdentityAvatar';
import { isPureAgentSession } from '../../features/agent-sessions/classification';

interface Props {
  open: boolean;
  projects: Project[];
  sessions: SessionMeta[];
  activeSessionId: string | null;
  onClose: () => void;
  onSelectSession: (session: SessionMeta) => void;
  onOpenHome: (project: Project) => void;
  onNewTeammate: () => void;
  onOpenAll: () => void;
}

export function AITeamQuickPanel({
  open,
  projects,
  sessions,
  activeSessionId,
  onClose,
  onSelectSession,
  onOpenHome,
  onNewTeammate,
  onOpenAll,
}: Props) {
  const { t } = useTranslation('layout');
  const [queryInput, setQueryInput] = React.useState('');

  React.useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const formatRelativeTime = (value: string | undefined) => {
    const timestamp = new Date(value || 0).getTime();
    const hours = Math.floor((Date.now() - timestamp) / 36e5);
    if (hours < 1) return t('aiTeamQuickPanel.time.justNow');
    if (hours < 24) return t('aiTeamQuickPanel.time.hoursAgo', { count: hours });
    return t('aiTeamQuickPanel.time.daysAgo', { count: Math.floor(hours / 24) });
  };

  const teammates = projects.filter((project) => !project.archived && project.systemKey !== 'ai-talent-team');
  const visibleSessions = sessions
    .filter((session) => !isPureAgentSession(session) && session.projectId)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime());
  const recentSessions = visibleSessions.slice(0, 6);
  const recentProjectIds = [...new Set(visibleSessions.map((session) => session.projectId))];
  const recentTeammates = recentProjectIds
    .map((id) => teammates.find((project) => project.id === id))
    .filter((project): project is Project => Boolean(project))
    .slice(0, 6);
  const query = queryInput.trim().toLowerCase();
  const results = query
    ? [
        ...teammates
          .filter((project) => [project.name, project.agent?.displayName, project.agent?.tagline, project.agent?.role]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(query))
          .map((project) => ({ kind: 'team' as const, project })),
        ...visibleSessions
          .filter((session) => session.name.toLowerCase().includes(query))
          .slice(0, 8)
          .map((session) => ({ kind: 'session' as const, session })),
      ]
    : [];

  return (
    <>
      <button
        aria-label={t('aiTeamQuickPanel.close')}
        className="fixed inset-0 z-[88] bg-black/25 backdrop-blur-[1px]"
        onClick={onClose}
      />
      <aside
        aria-label={t('aiTeamQuickPanel.ariaLabel')}
        className="agent-product-surface fixed inset-y-0 right-0 z-[89] flex w-full max-w-[420px] flex-col border-l border-surface-800 bg-surface-950/95 shadow-2xl shadow-black/30"
      >
        <header className="border-b border-surface-800 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[.18em] text-primary-300">
                {t('aiTeamQuickPanel.eyebrow')}
              </div>
              <h2 className="mt-1 text-lg font-bold text-surface-100">{t('aiTeam')}</h2>
            </div>
            <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-surface-500 hover:bg-surface-800 hover:text-surface-200">
              {t('aiTeamQuickPanel.close')}
            </button>
          </div>
          <input
            autoFocus
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
            placeholder={t('aiTeamQuickPanel.searchPlaceholder')}
            className="mt-3 w-full rounded-xl border border-surface-700 bg-surface-900/75 px-3 py-2.5 text-sm text-surface-100 outline-none placeholder:text-surface-600 focus:border-primary-500/60"
          />
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {query ? (
            <section>
              <div className="text-[11px] font-bold text-surface-500">{t('aiTeamQuickPanel.searchResults')}</div>
              <div className="mt-2 divide-y divide-surface-800">
                {results.length ? results.map((result, index) => result.kind === 'team' ? (
                  <button key={`p-${result.project.id}`} onClick={() => { onOpenHome(result.project); onClose(); }} className="flex w-full items-center gap-3 py-3 text-left">
                    <AgentIdentityAvatar project={result.project} className="h-10 w-10 rounded-xl" />
                    <span>
                      <b className="block text-sm text-surface-200">{result.project.agent?.displayName || result.project.name}</b>
                      <small className="text-surface-500">{t('aiTeamQuickPanel.teammate')}</small>
                    </span>
                  </button>
                ) : (
                  <button key={`s-${result.session.id}-${index}`} onClick={() => { onSelectSession(result.session); onClose(); }} className="w-full py-3 text-left">
                    <b className="block truncate text-sm text-surface-200">{result.session.name}</b>
                    <small className="text-surface-500">
                      {t('aiTeamQuickPanel.conversation')} · {formatRelativeTime(result.session.updatedAt || result.session.createdAt)}
                    </small>
                  </button>
                )) : (
                  <p className="py-6 text-center text-sm text-surface-500">{t('aiTeamQuickPanel.noResults')}</p>
                )}
              </div>
            </section>
          ) : (
            <>
              <section>
                <div className="flex items-center justify-between">
                  <div className="text-[11px] font-bold text-surface-500">{t('aiTeamQuickPanel.continueWorking')}</div>
                  <span className="text-[10px] text-surface-600">{t('aiTeamQuickPanel.recentConversations')}</span>
                </div>
                <div className="mt-2 divide-y divide-surface-800">
                  {recentSessions.map((session) => {
                    const project = teammates.find((candidate) => candidate.id === session.projectId);
                    return (
                      <button key={session.id} onClick={() => { onSelectSession(session); onClose(); }} className={`flex w-full gap-3 py-3 text-left ${session.id === activeSessionId ? 'text-primary-300' : ''}`}>
                        {project && <AgentIdentityAvatar project={project} className="h-10 w-10 shrink-0 rounded-xl" />}
                        <span className="min-w-0">
                          <b className="block truncate text-sm text-surface-200">{session.name}</b>
                          <small className="block truncate text-surface-500">
                            {project?.agent?.displayName || project?.name || t('aiTeamQuickPanel.teammate')} · {formatRelativeTime(session.updatedAt || session.createdAt)}
                          </small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
              <section className="mt-6">
                <div className="text-[11px] font-bold text-surface-500">{t('aiTeamQuickPanel.recentTeammates')}</div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {recentTeammates.map((project) => (
                    <button key={project.id} onClick={() => { onOpenHome(project); onClose(); }} className="flex min-w-0 items-center gap-2 rounded-xl border border-surface-800 p-2.5 text-left hover:border-primary-500/35">
                      <AgentIdentityAvatar project={project} className="h-9 w-9 shrink-0 rounded-lg" />
                      <span className="min-w-0 truncate text-xs font-bold text-surface-200">{project.agent?.displayName || project.name}</span>
                    </button>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>

        <footer className="grid gap-2 border-t border-surface-800 p-4">
          <button onClick={() => { onNewTeammate(); onClose(); }} className="rounded-xl bg-primary-500 px-4 py-3 text-sm font-bold text-white hover:bg-primary-400">
            ＋ {t('aiTeamQuickPanel.newTeammate')}
          </button>
          <button onClick={() => { onOpenAll(); onClose(); }} className="rounded-xl border border-surface-700 px-4 py-2.5 text-sm font-semibold text-surface-300 hover:border-primary-500/40">
            {t('aiTeamQuickPanel.manageAll')} →
          </button>
        </footer>
      </aside>
    </>
  );
}
