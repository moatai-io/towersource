import { towerHttpUrl, readBrowserAuthToken } from '../../features/client-connection/connection';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project, SessionMeta } from '@tower/shared';
import { useSessionStore } from '../../stores/session-store';

const headers = () => ({ Authorization: `Bearer ${readBrowserAuthToken() || ''}` });

type DirectoryMode = 'active' | 'archived';

interface SessionDirectoryPanelProps {
  sessions: SessionMeta[];
  projects: Project[];
  mode?: DirectoryMode;
  initialProjectId?: string | null;
  initialLabel?: string | null;
  onSelectSession: (session: SessionMeta) => void;
  onClose: () => void;
}

type SortMode = 'updated-desc' | 'created-desc' | 'name-asc' | 'turns-desc';
type DateRange = 'all' | '7d' | '30d';
type StatusFilter = 'active' | 'archived' | 'all';
const DEFAULT_LABEL = '__default__';

function MultiFilter({ label, values, options, onToggle }: { label: string; values: Set<string>; options: Array<{ value: string; label: string }>; onToggle: (value: string) => void }) {
  const summary = values.size === 0 ? label : `${label} · ${values.size}`;
  return <details className="relative">
    <summary className="cursor-pointer list-none rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-sm text-surface-300 marker:hidden">{summary}<span className="float-right text-surface-600">⌄</span></summary>
    <div className="absolute z-30 mt-1 max-h-64 w-full min-w-[190px] overflow-y-auto rounded-lg border border-surface-700 bg-surface-900 p-1 shadow-xl">
      {options.map((option) => <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-surface-300 hover:bg-surface-800"><input type="checkbox" checked={values.has(option.value)} onChange={() => onToggle(option.value)} /><span className="truncate">{option.label}</span></label>)}
    </div>
  </details>;
}

export function SessionDirectoryPanel({ sessions, projects, mode = 'active', initialProjectId, initialLabel, onSelectSession, onClose }: SessionDirectoryPanelProps) {
  const { t, i18n } = useTranslation('layout');
  const isMobile = useSessionStore((state) => state.isMobile);
  const archivedMode = mode === 'archived';
  const [archivedSessions, setArchivedSessions] = useState<SessionMeta[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(archivedMode);
  const [archiveError, setArchiveError] = useState(false);
  const [archiveAttempt, setArchiveAttempt] = useState(0);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [projectIds, setProjectIds] = useState<Set<string>>(() => initialProjectId ? new Set([initialProjectId]) : new Set());
  const [labels, setLabels] = useState<Set<string>>(() => initialLabel === undefined ? new Set() : new Set([initialLabel === null ? DEFAULT_LABEL : initialLabel]));
  const [owner, setOwner] = useState('all');
  const [dateRange, setDateRange] = useState<DateRange>('all');
  const [status, setStatus] = useState<StatusFilter>('active');
  const [sort, setSort] = useState<SortMode>('updated-desc');
  const directorySessions = archivedMode ? archivedSessions : sessions;
  const projectNames = useMemo(() => new Map(projects.map((project) => [project.id, project.agent?.displayName || project.name])), [projects]);
  const deckLabels = useMemo(() => [...new Set(directorySessions.map((session) => session.label).filter((value): value is string => Boolean(value)))].sort(), [directorySessions]);
  const owners = useMemo(() => [...new Set(directorySessions.map((session) => session.ownerUsername).filter((value): value is string => Boolean(value)))].sort(), [directorySessions]);
  const toggleSetValue = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, value: string) => setter((current) => { const next = new Set(current); if (next.has(value)) next.delete(value); else next.add(value); return next; });
  const clearFilters = () => { setQuery(''); setProjectIds(new Set()); setLabels(new Set()); setOwner('all'); setDateRange('all'); setStatus('active'); };
  const hasFilters = query || projectIds.size > 0 || labels.size > 0 || owner !== 'all' || dateRange !== 'all' || (!archivedMode && status !== 'active');

  useEffect(() => {
    if (!archivedMode) return;
    const controller = new AbortController();
    setArchiveLoading(true);
    setArchiveError(false);
    fetch(towerHttpUrl(`/api/sessions/archived`), { headers: headers(), signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('archive');
        const data = await response.json();
        if (!Array.isArray(data)) throw new Error('archive');
        if (!controller.signal.aborted) setArchivedSessions(data);
      })
      .catch(() => { if (!controller.signal.aborted) setArchiveError(true); })
      .finally(() => { if (!controller.signal.aborted) setArchiveLoading(false); });
    return () => controller.abort();
  }, [archiveAttempt, archivedMode]);

  async function restoreSession(session: SessionMeta) {
    if (restoringId) return;
    setRestoringId(session.id);
    setArchiveError(false);
    try {
      const response = await fetch(towerHttpUrl(`/api/sessions/${encodeURIComponent(session.id)}/restore`), { method: 'POST', headers: headers() });
      if (!response.ok) throw new Error('restore');
      const data = await response.json();
      if (!data.session?.id) throw new Error('restore');
      useSessionStore.getState().mergeSessions([data.session]);
      setArchivedSessions((current) => current.filter((item) => item.id !== session.id));
      window.dispatchEvent(new CustomEvent('tower-session-archive-changed'));
    } catch {
      setArchiveError(true);
    } finally {
      setRestoringId(null);
    }
  }

  const visibleSessions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const cutoff = dateRange === 'all' ? 0 : Date.now() - (dateRange === '7d' ? 7 : 30) * 24 * 60 * 60 * 1000;
    return directorySessions
      // The server audience query is authoritative. Exclude operator-only metadata
      // rows that were deliberately redacted and therefore have no transcript fields.
      .filter((session) => session.currentUserParticipated !== undefined || session.totalTokens !== undefined)
      .filter((session) => archivedMode || status === 'all' || (status === 'archived' ? session.archived : !session.archived))
      .filter((session) => projectIds.size === 0 || (!!session.projectId && projectIds.has(session.projectId)))
      .filter((session) => labels.size === 0 || labels.has(session.label || DEFAULT_LABEL))
      .filter((session) => owner === 'all' || session.ownerUsername === owner)
      .filter((session) => cutoff === 0 || new Date(session.updatedAt).getTime() >= cutoff)
      .filter((session) => !normalizedQuery || session.name.toLocaleLowerCase().includes(normalizedQuery) || session.ownerUsername?.toLocaleLowerCase().includes(normalizedQuery))
      .sort((a, b) => {
        if (sort === 'name-asc') return a.name.localeCompare(b.name, i18n.language);
        if (sort === 'turns-desc') return (b.userTurnCount || b.turnCount || 0) - (a.userTurnCount || a.turnCount || 0);
        const left = new Date(sort === 'created-desc' ? a.createdAt : a.updatedAt).getTime();
        const right = new Date(sort === 'created-desc' ? b.createdAt : b.updatedAt).getTime();
        return right - left;
      });
  }, [archivedMode, dateRange, directorySessions, i18n.language, labels, owner, projectIds, query, sort, status]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-surface-950" aria-label={t(archivedMode ? 'archivedSessionsTitle' : 'allSessions')}>
      <header className="border-b border-surface-800 px-4 py-4 sm:px-6"><div className="mx-auto flex max-w-6xl items-start justify-between gap-4"><div className="min-w-0"><h1 className="text-xl font-semibold text-surface-100">{t(archivedMode ? 'archivedSessionsTitle' : 'allSessions')}</h1><p className="mt-1 text-sm text-surface-500">{t(archivedMode ? 'archivedSessionDirectoryDescription' : 'sessionDirectoryDescription')}</p></div><button type="button" onClick={onClose} className="shrink-0 rounded-lg border border-surface-700 px-3 py-1.5 text-sm text-surface-300 hover:bg-surface-800">{t('backToSession')}</button></div></header>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-4 sm:px-6"><div className="mx-auto max-w-6xl">
        <div className="grid gap-2 rounded-xl border border-surface-800 bg-surface-900/60 p-3 sm:grid-cols-2 lg:grid-cols-4">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('searchSessions')} className="rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-base text-surface-200 placeholder:text-surface-600 sm:col-span-2 sm:text-sm" autoFocus={!isMobile} />
          <MultiFilter label={t('allProjects')} values={projectIds} options={projects.map((project) => ({ value: project.id, label: project.agent?.displayName || project.name }))} onToggle={(value) => toggleSetValue(setProjectIds, value)} />
          <MultiFilter label={t('allDecks')} values={labels} options={[{ value: DEFAULT_LABEL, label: t('defaultDeck') }, ...deckLabels.map((deckLabel) => ({ value: deckLabel, label: deckLabel }))]} onToggle={(value) => toggleSetValue(setLabels, value)} />
          <select value={owner} onChange={(event) => setOwner(event.target.value)} className="rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-sm text-surface-300"><option value="all">{t('allCreators')}</option>{owners.map((name) => <option key={name} value={name}>{name}</option>)}</select>
          <select value={dateRange} onChange={(event) => setDateRange(event.target.value as DateRange)} className="rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-sm text-surface-300"><option value="all">{t('allDates')}</option><option value="7d">{t('last7Days')}</option><option value="30d">{t('last30Days')}</option></select>
          {!archivedMode && <select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)} className="rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-sm text-surface-300"><option value="active">{t('activeSessions')}</option><option value="archived">{t('archivedSessions')}</option><option value="all">{t('allStatuses')}</option></select>}
          <select value={sort} onChange={(event) => setSort(event.target.value as SortMode)} className="rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-sm text-surface-300"><option value="updated-desc">{t('sortLatestActivity')}</option><option value="created-desc">{t('sortNewestCreated')}</option><option value="name-asc">{t('sortName')}</option><option value="turns-desc">{t('sortMostTurns')}</option></select>
        </div>
        <div className="mt-4 flex items-center justify-between text-sm text-surface-500"><span>{t('sessionResults', { count: visibleSessions.length })}</span>{hasFilters && <button type="button" onClick={clearFilters} className="text-primary-400 hover:text-primary-300">{t('clearFilters')}</button>}</div>
        {archiveLoading && <p className="py-12 text-center text-sm text-surface-500" role="status">{t('common:loading')}</p>}
        {archiveError && <div className="my-3 flex items-center justify-between rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200" role="alert"><span>{t('sessionTrashFailed')}</span><button type="button" onClick={() => setArchiveAttempt((value) => value + 1)} className="rounded px-2 py-1 font-semibold hover:bg-red-500/10">{t('sessionTrashRetry')}</button></div>}
        {!archiveLoading && <div className="mt-2 overflow-hidden rounded-xl border border-surface-800 bg-surface-900/35"><table className="w-full table-fixed border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-surface-900 text-[11px] font-semibold text-surface-500"><tr className="border-b border-surface-800"><th className="w-[36%] px-3 py-2 sm:w-[32%] lg:w-[30%]">{t('sessionColumn')}</th><th className="hidden w-[12%] px-2 py-2 xl:table-cell">{t('creatorColumn')}</th><th className="hidden w-[12%] px-2 py-2 md:table-cell">{t('deckColumn')}</th><th className="w-[22%] px-2 py-2 sm:w-[18%]">{t('projectColumn')}</th><th className="hidden w-[7%] px-2 py-2 text-right sm:table-cell">{t('turnsColumn')}</th><th className="hidden w-[7%] px-2 py-2 text-right lg:table-cell">{t('participantsColumn')}</th><th className="w-[24%] px-2 py-2 sm:w-[18%]">{t('activityColumn')}</th>{archivedMode && <th className="w-[18%] px-2 py-2 text-right sm:w-[11%]">{t('sessionActionsColumn')}</th>}</tr></thead>
          <tbody className="divide-y divide-surface-800">{visibleSessions.map((session) => { const dateFormatter = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'short' }); return <tr key={session.id} onClick={() => onSelectSession(session)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelectSession(session); }} className="cursor-pointer text-[12px] text-surface-400 outline-none hover:bg-surface-800/70 focus-visible:bg-surface-800/70"><td className="truncate px-3 py-1.5 font-medium text-surface-200" title={session.name}>{session.name}</td><td className="hidden truncate px-2 py-1.5 xl:table-cell">{session.ownerUsername || t('unknownOwner')}</td><td className="hidden truncate px-2 py-1.5 md:table-cell">{session.label || t('defaultDeck')}</td><td className="truncate px-2 py-1.5">{projectNames.get(session.projectId || '') || t('unknownProject')}</td><td className="hidden px-2 py-1.5 text-right tabular-nums sm:table-cell">{session.userTurnCount || session.turnCount || 0}</td><td className="hidden px-2 py-1.5 text-right tabular-nums lg:table-cell">{session.participantCount || (session.ownerUsername ? 1 : 0)}</td><td className="px-2 py-1.5 text-[11px] leading-4"><time dateTime={session.updatedAt}>{dateFormatter.format(new Date(session.updatedAt))}</time><span className="hidden text-surface-600 sm:block">{dateFormatter.format(new Date(session.createdAt))}</span></td>{archivedMode && <td className="px-2 py-1.5 text-right"><button type="button" disabled={restoringId !== null || !!session.agent?.workerId} onClick={(event) => { event.stopPropagation(); void restoreSession(session); }} className="rounded-md border border-surface-700 px-2 py-1 font-semibold text-surface-300 hover:bg-surface-800 disabled:opacity-40">{restoringId === session.id ? t('common:loading') : t('sessionTrashRestore')}</button></td>}</tr>; })}{visibleSessions.length === 0 && <tr><td colSpan={archivedMode ? 9 : 8} className="px-4 py-12 text-center text-sm text-surface-500">{t(archivedMode ? 'sessionTrashEmpty' : 'noSessionResults')}</td></tr>}</tbody>
        </table></div>}
      </div></div>
    </section>
  );
}
