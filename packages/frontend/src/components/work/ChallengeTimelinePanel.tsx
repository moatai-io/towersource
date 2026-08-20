import React from 'react';
import i18n from '../../i18n';
import { agentFaceImageUrl, AgentCharacterAvatar, characterFace, distributedKoreanCharacterId } from '../../features/agent-profile/characters';
import { PersonalUsageSummary } from './PersonalUsageSummary';

interface Segment {
  start: string;
  end: string;
  kind: 'work' | 'active' | 'done';
  snapshotCount: number;
}

interface FollowUpItem {
  type?: string;
  title: string;
  priority?: string;
  reason?: string;
}

interface WorkQuestion {
  title: string;
  status?: string;
  reason?: string;
}

interface TodoSummaryItem {
  content: string;
  status: string;
}

interface WorkSession {
  id: string;
  name: string;
  owner: string;
  agentName: string;
  agentFace: string | null;
  projectId: string | null;
  projectName: string;
  lastAt: string;
  snapshotCount: number;
  todoTotal: number;
  todoDone: number;
  todoLeft: number;
  runTitles: string[];
  openTodos?: TodoSummaryItem[];
  completedTodos?: TodoSummaryItem[];
}

interface ChallengeRow {
  id: string;
  title: string;
  workstreamKey?: string;
  runTitles?: string[];
  outcomes?: string[];
  projectId: string | null;
  projectName: string;
  owners: string[];
  sessionCount: number;
  todoTotal: number;
  todoDone: number;
  todoLeft: number;
  backlog?: FollowUpItem[];
  questions?: WorkQuestion[];
  sessions?: WorkSession[];
  status: 'active' | 'waiting' | 'resolved';
  waitingReason?: 'stale' | 'blocked' | 'failed' | 'unfinished' | null;
  lastAt: string;
  segments: Segment[];
}

interface ProjectGroup {
  id: string | null;
  name: string;
  challengeCount: number;
  todoLeft: number;
  challenges: ChallengeRow[];
}

interface TimelineResponse {
  rangeHours: number;
  bucketHours: number;
  start: string;
  end: string;
  ticks: string[];
  projects: ProjectGroup[];
  totals: {
    projects: number;
    challenges: number;
    todoLeft: number;
    snapshots: number;
  };
}

function tr(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, { ns: 'common', ...options });
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function readWorkstreamLocation(): { workstreamKey: string | null; projectId: string } {
  const params = new URLSearchParams(window.location.search);
  return { workstreamKey: params.get('workstream'), projectId: params.get('workProject') || 'all' };
}

function writeWorkstreamLocation(workstreamKey: string | null, projectId: string, mode: 'push' | 'replace'): void {
  const url = new URL(window.location.href);
  url.searchParams.set('view', 'work');
  if (workstreamKey) url.searchParams.set('workstream', workstreamKey);
  else url.searchParams.delete('workstream');
  if (workstreamKey && projectId !== 'all') url.searchParams.set('workProject', projectId);
  else url.searchParams.delete('workProject');
  const state = workstreamKey ? { ...(window.history.state || {}), towerWorkstreamDetail: true } : { ...(window.history.state || {}), towerWorkstreamDetail: false };
  window.history[mode === 'push' ? 'pushState' : 'replaceState'](state, '', `${url.pathname}${url.search}${url.hash}`);
}

function formatDateTick(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(i18n.resolvedLanguage || i18n.language, { month: 'numeric', day: 'numeric' });
}

function midnightTicks(start: string, end: string): string[] {
  const min = new Date(start);
  const max = new Date(end);
  if (Number.isNaN(min.getTime()) || Number.isNaN(max.getTime())) return [];

  const first = new Date(min);
  first.setHours(0, 0, 0, 0);
  if (first.getTime() < min.getTime()) first.setDate(first.getDate() + 1);

  const ticks: string[] = [];
  for (let t = first.getTime(); t <= max.getTime(); t += 24 * 60 * 60_000) {
    ticks.push(new Date(t).toISOString());
  }
  return ticks;
}

function tickStyle(value: string, start: string, end: string): React.CSSProperties {
  const min = new Date(start).getTime();
  const max = new Date(end).getTime();
  const span = Math.max(max - min, 1);
  const at = new Date(value).getTime();
  const left = Math.max(0, Math.min(100, ((at - min) / span) * 100));
  return { left: `${left}%` };
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(i18n.resolvedLanguage || i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function segmentStyle(segment: Segment, start: string, end: string): React.CSSProperties {
  const min = new Date(start).getTime();
  const max = new Date(end).getTime();
  const span = Math.max(max - min, 1);
  const a = new Date(segment.start).getTime();
  const b = new Date(segment.end).getTime();
  const left = Math.max(0, Math.min(100, ((a - min) / span) * 100));
  const right = Math.max(left + 1.8, Math.min(100, ((b - min) / span) * 100));
  return { left: `${left}%`, width: `${Math.max(2.4, right - left)}%` };
}

function statusText(challenge: ChallengeRow): string {
  if (challenge.status === 'resolved') return i18n.t('challenge.statusText.done', { ns: 'common' });
  return i18n.t('challenge.statusText.left', { ns: 'common', count: challenge.todoLeft });
}

function workstreamKey(challenge: ChallengeRow): string {
  return challenge.workstreamKey || challenge.id;
}

function workstreamStatusLabel(challenge: ChallengeRow): string {
  if (challenge.waitingReason === 'stale') return tr('challenge.timeline.status.stale', { ns: 'common' });
  if (challenge.waitingReason === 'blocked') return tr('challenge.timeline.status.blocked', { ns: 'common' });
  if (challenge.waitingReason === 'failed') return tr('challenge.timeline.status.failed', { ns: 'common' });
  const key = challenge.status === 'resolved' ? 'resolved' : challenge.status === 'waiting' ? 'waiting' : 'active';
  return i18n.t(`challenge.status.${key}`, { ns: 'common' });
}

function workstreamActionLabel(challenge: ChallengeRow): string {
  const key = challenge.status === 'resolved' ? 'viewResult' : challenge.status === 'waiting' ? 'review' : 'continue';
  return i18n.t(`challenge.action.${key}`, { ns: 'common' });
}

function segmentClass(kind: Segment['kind']): string {
  if (kind === 'done') return 'bg-emerald-400/30 text-emerald-900 dark:text-emerald-100 border-emerald-300/45';
  if (kind === 'active') return 'bg-amber-300/35 text-amber-900 dark:text-amber-100 border-amber-200/55';
  return 'bg-primary-400/35 text-primary-800 dark:text-primary-100 border-primary-300/55';
}

function openSession(sessionId: string) {
  window.dispatchEvent(new CustomEvent('kanban-select-session', { detail: { sessionId } }));
}

function activityStatus(session: WorkSession, challenge: ChallengeRow): { label: string; tone: string } {
  if (challenge.waitingReason === 'stale') return { label: tr('challenge.timeline.status.stale', { ns: 'common' }), tone: 'text-surface-300 bg-surface-800 border-surface-700' };
  if (challenge.waitingReason === 'blocked') return { label: tr('challenge.timeline.status.blocked', { ns: 'common' }), tone: 'text-amber-700 dark:text-amber-300 bg-amber-500/10 border-amber-400/20' };
  if (challenge.waitingReason === 'failed') return { label: tr('challenge.timeline.status.failed', { ns: 'common' }), tone: 'text-red-700 dark:text-red-200 bg-red-500/10 border-red-400/20' };
  if (session.todoTotal > 0 && session.todoLeft === 0) return { label: tr('challenge.timeline.status.completed', { ns: 'common' }), tone: 'text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 border-emerald-400/20' };
  if (session.openTodos?.some((todo) => todo.status === 'in_progress')) return { label: tr('challenge.timeline.status.inProgress', { ns: 'common' }), tone: 'text-amber-700 dark:text-amber-300 bg-amber-500/10 border-amber-400/20' };
  return { label: tr('challenge.timeline.status.needsReview', { ns: 'common' }), tone: 'text-surface-300 bg-surface-800 border-surface-700' };
}

function AgentFace({ session }: { session: WorkSession }) {
  const faceImage = agentFaceImageUrl(session.agentFace);
  const characterId = characterFace(session.agentFace);
  if (faceImage && !characterId) return <img src={faceImage} alt="" className="h-11 w-11 shrink-0 rounded-xl object-cover" aria-hidden="true" />;
  return <AgentCharacterAvatar id={characterId || distributedKoreanCharacterId(session.projectId || session.id)} className="h-11 w-11 shrink-0 rounded-xl" variant="list" title={session.agentName} />;
}

export function ChallengeTimelinePanel() {
  const initialLocation = React.useMemo(() => readWorkstreamLocation(), []);
  const [rangeHours, setRangeHours] = React.useState(48);
  const [bucketHours, setBucketHours] = React.useState(24);
  const [projectId, setProjectId] = React.useState(initialLocation.projectId);
  const [data, setData] = React.useState<TimelineResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        rangeHours: String(rangeHours),
        bucketHours: String(bucketHours),
        limit: '120',
      });
      if (projectId !== 'all') params.set('projectId', projectId);
      const res = await fetch(`/api/work/challenge-timeline?${params.toString()}`, { headers: authHeaders() });
      if (!res.ok) throw new Error(await res.text());
      setData(await res.json());
    } catch (err: any) {
      setError(err?.message || tr('challenge.timeline.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [bucketHours, projectId, rangeHours]);

  const [selectedWorkstreamKey, setSelectedWorkstreamKey] = React.useState<string | null>(initialLocation.workstreamKey);

  const selectWorkstream = React.useCallback((key: string, nextProjectId = projectId) => {
    setSelectedWorkstreamKey(key);
    writeWorkstreamLocation(key, nextProjectId, 'push');
  }, [projectId]);

  const returnToActivity = React.useCallback(() => {
    if (window.history.state?.towerWorkstreamDetail) {
      window.history.back();
      return;
    }
    setSelectedWorkstreamKey(null);
    setProjectId('all');
    writeWorkstreamLocation(null, 'all', 'replace');
  }, []);

  React.useEffect(() => { load(); }, [load]);

  React.useEffect(() => {
    const selectProject = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; workstreamKey?: string; rangeHours?: number }>).detail;
      const nextProjectId = detail?.projectId || 'all';
      if (detail?.projectId) setProjectId(detail.projectId);
      if (detail?.rangeHours) setRangeHours(detail.rangeHours);
      if (detail?.workstreamKey) selectWorkstream(detail.workstreamKey, nextProjectId);
    };
    window.addEventListener('tower-open-project-work', selectProject);
    return () => window.removeEventListener('tower-open-project-work', selectProject);
  }, [selectWorkstream]);

  React.useEffect(() => {
    const restoreWorkstreamLocation = () => {
      const location = readWorkstreamLocation();
      setSelectedWorkstreamKey(location.workstreamKey);
      setProjectId(location.projectId);
    };
    window.addEventListener('popstate', restoreWorkstreamLocation);
    return () => window.removeEventListener('popstate', restoreWorkstreamLocation);
  }, []);

  React.useEffect(() => {
    if (!selectedWorkstreamKey || loading || !data) return;
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-workstream-key="${CSS.escape(selectedWorkstreamKey)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  }, [data, loading, selectedWorkstreamKey]);

  const projectsForFilter = data?.projects || [];
  const selectedChallenge = React.useMemo(() => {
    if (!selectedWorkstreamKey || !data) return null;
    return data.projects.flatMap((project) => project.challenges).find((challenge) => workstreamKey(challenge) === selectedWorkstreamKey) || null;
  }, [data, selectedWorkstreamKey]);

  return (
    <div data-testid="work-timeline" className="relative z-10 flex h-full min-h-0 w-full max-w-full flex-col overflow-x-hidden overflow-y-auto overscroll-x-none bg-surface-950 text-surface-100 md:overflow-hidden">
      <div className="border-b border-surface-800/80 bg-surface-950/95 px-4 py-3 backdrop-blur-xl md:shrink-0 md:px-5 md:py-4">
        <div className="flex flex-wrap items-start justify-between gap-3 md:gap-4">
          <div>
            <div className="hidden text-[12px] font-semibold uppercase tracking-[0.18em] text-primary-700/90 dark:text-primary-300/80 md:mb-1 md:block">Activity briefing</div>
            <h1 className="text-[20px] font-semibold tracking-tight text-surface-50 md:text-[24px]">{tr('challenge.timeline.title')}</h1>
            <p className="mt-1 hidden max-w-3xl text-[13px] leading-6 text-surface-500 md:block">
              {tr('challenge.timeline.description')}
            </p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 md:w-auto">
            <select value={rangeHours} onChange={(e) => setRangeHours(Number(e.target.value))} className="h-9 rounded-lg border border-surface-700 bg-surface-900 px-3 text-[13px] text-surface-200 outline-none focus:border-primary-500/70">
              <option value={48}>{tr('challenge.timeline.last2Days')}</option>
              <option value={168}>{tr('challenge.timeline.last7Days')}</option>
              <option value={360}>{tr('challenge.timeline.last15Days')}</option>
            </select>
            <select value={bucketHours} onChange={(e) => setBucketHours(Number(e.target.value))} className="h-9 rounded-lg border border-surface-700 bg-surface-900 px-3 text-[13px] text-surface-200 outline-none focus:border-primary-500/70">
              <option value={6}>{tr('challenge.timeline.every6Hours')}</option>
              <option value={24}>{tr('challenge.timeline.daily')}</option>
            </select>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="h-9 min-w-0 flex-1 rounded-lg border border-surface-700 bg-surface-900 px-3 text-[13px] text-surface-200 outline-none focus:border-primary-500/70 md:max-w-[220px] md:flex-none">
              <option value="all">{tr('challenge.timeline.allAssignedWork')}</option>
              {projectsForFilter.map((project) => (
                <option key={project.id || 'none'} value={project.id || 'none'}>{project.name}</option>
              ))}
            </select>
            <button onClick={load} disabled={loading} className="h-9 rounded-lg border border-surface-700 bg-surface-850 px-3 text-[13px] font-medium text-surface-300 transition-colors hover:border-primary-500/40 hover:text-primary-700 dark:text-primary-200 disabled:opacity-50">
              {loading ? tr('challenge.timeline.loadingShort') : tr('challenge.timeline.refresh')}
            </button>
          </div>
        </div>

        <div className="mt-3 hidden grid-cols-2 gap-1.5 md:grid md:grid-cols-3">
          <Stat label={tr('challenge.timeline.aiTeammates')} value={new Set((data?.projects || []).flatMap((project) => project.challenges.flatMap((challenge) => (challenge.sessions || []).map((session) => session.agentName)))).size} />
          <Stat label={tr('challenge.timeline.recentActivity')} value={(data?.projects || []).reduce((sum, project) => sum + project.challenges.reduce((inner, challenge) => inner + (challenge.sessions?.length || 0), 0), 0)} tone="primary" />
          <Stat label={tr('challenge.timeline.stepsToReview')} value={data?.totals.todoLeft ?? 0} tone="amber" />
        </div>
      </div>

      <div className="min-w-0 max-w-full flex-none overflow-x-hidden px-4 py-3 md:min-h-0 md:flex-1 md:overflow-auto md:px-5 md:py-4">
        <PersonalUsageSummary />
        {error ? (
          <div className="rounded-xl border border-red-400/20 bg-red-500/10 p-4 text-[14px] text-red-700 dark:text-red-200">{error}</div>
        ) : !data || loading ? (
          <div className="rounded-xl border border-surface-800 bg-surface-900/60 p-6 text-[14px] text-surface-500">{tr('challenge.timeline.loading')}</div>
        ) : data.projects.length === 0 ? (
          <div className="rounded-xl border border-dashed border-surface-700 bg-surface-900/40 p-10 text-center text-surface-500">{tr('challenge.timeline.empty')}</div>
        ) : selectedChallenge ? (
          <WorkstreamOverview challenge={selectedChallenge} onBack={returnToActivity} />
        ) : (
          <AgentActivityTimeline projects={data.projects} selectedWorkstreamKey={selectedWorkstreamKey} onSelectWorkstream={(key) => selectWorkstream(key, data.projects.flatMap((project) => project.challenges).find((challenge) => workstreamKey(challenge) === key)?.projectId || 'all')} />
        )}
      </div>
    </div>
  );
}

function AgentActivityTimeline({ projects, selectedWorkstreamKey, onSelectWorkstream }: { projects: ProjectGroup[]; selectedWorkstreamKey: string | null; onSelectWorkstream: (key: string) => void }) {
  const [expandedAgents, setExpandedAgents] = React.useState<Set<string>>(() => new Set());
  const activities = projects
    .flatMap((project) => project.challenges.flatMap((challenge) => (challenge.sessions || []).map((session) => ({ session, challenge }))))
    .sort((a, b) => new Date(b.session.lastAt).getTime() - new Date(a.session.lastAt).getTime());
  const groups = Array.from(activities.reduce((map, activity) => {
    const key = `${activity.session.projectId || 'none'}:${activity.session.agentName}`;
    const current = map.get(key) || { key, session: activity.session, items: [] as typeof activities };
    current.items.push(activity);
    map.set(key, current);
    return map;
  }, new Map<string, { key: string; session: WorkSession; items: typeof activities }>()).values());

  return (
    <section aria-labelledby="agent-activity-title" className="overflow-hidden rounded-xl border border-surface-800 bg-surface-900/55">
      <div className="border-b border-surface-800 bg-surface-950/45 px-4 py-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary-700/90 dark:text-primary-300/80">Recent activity</div>
        <h2 id="agent-activity-title" className="mt-0.5 text-[17px] font-semibold text-surface-100">{tr('challenge.timeline.recentActivity')}</h2>
        <p className="mt-1 text-[12px] leading-5 text-surface-500">{tr('challenge.timeline.groupDescription')}</p>
      </div>
      <div className="divide-y divide-surface-800">
        {groups.map((group) => {
          const expanded = expandedAgents.has(group.key);
          const visibleItems = expanded ? group.items : group.items.slice(0, 3);
          return <div key={group.key} className="px-4 py-3">
            <div className="mb-2 flex items-center gap-3">
              <AgentFace session={group.session} />
              <div className="min-w-0 flex-1"><div className="text-[13px] font-semibold text-surface-100">{group.session.agentName}</div><div className="text-[11px] text-surface-600">{tr('challenge.timeline.recentWorkCount', { project: group.session.projectName, count: group.items.length })}</div></div>
              {group.items.length > 3 && <button type="button" onClick={() => setExpandedAgents((current) => { const next = new Set(current); expanded ? next.delete(group.key) : next.add(group.key); return next; })} className="rounded-md border border-surface-700 px-2 py-1 text-[11px] text-surface-400 hover:text-surface-100">{expanded ? tr('challenge.timeline.collapse') : tr('challenge.timeline.showMore', { count: group.items.length - 3 })}</button>}
            </div>
            <div className="divide-y divide-surface-800/70 border-t border-surface-800/70">
              {visibleItems.map(({ session, challenge }) => {
                const status = activityStatus(session, challenge);
                const title = session.runTitles[session.runTitles.length - 1] || session.name;
                const summary = session.openTodos?.[0]?.content || session.completedTodos?.[session.completedTodos.length - 1]?.content || challenge.outcomes?.[challenge.outcomes.length - 1];
                const key = workstreamKey(challenge);
                const selected = selectedWorkstreamKey === key;
                return <button key={`${challenge.id}:${session.id}`} type="button" data-workstream-key={key} aria-current={selected ? 'true' : undefined} onClick={() => onSelectWorkstream(key)} className={`grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 rounded-md px-1 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500/60 ${selected ? 'bg-primary-500/10 ring-1 ring-inset ring-primary-500/35' : 'hover:bg-surface-800/25'}`}><div className="min-w-0"><div className="flex items-center gap-2"><span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-semibold ${status.tone}`}>{status.label}</span><span className="truncate text-[12px] font-medium text-surface-200">{title}</span></div>{summary && <div className="mt-0.5 truncate pl-[3.9rem] text-[11px] text-surface-500">{summary}</div>}</div><time className="pt-0.5 text-[10px] text-surface-600">{formatDateTime(session.lastAt)}</time></button>;
              })}
            </div>
          </div>;
        })}
      </div>
    </section>
  );
}

function WorkstreamOverview({ challenge, onBack }: { challenge: ChallengeRow; onBack: () => void }) {
  const sessions = [...(challenge.sessions || [])].sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime());
  const primarySession = sessions[0];
  const openTodos = sessions.flatMap((session) => session.openTodos || []);
  const completedTodos = sessions.flatMap((session) => session.completedTodos || []);
  const outcome = challenge.outcomes?.[challenge.outcomes.length - 1];
  const currentSummary = openTodos[0]?.content || outcome || challenge.runTitles?.[challenge.runTitles.length - 1] || tr('challenge.timeline.noCurrentSummary');
  const progress = challenge.todoTotal > 0 ? Math.round((challenge.todoDone / challenge.todoTotal) * 100) : challenge.status === 'resolved' ? 100 : 0;
  const statusTone = challenge.status === 'resolved'
    ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    : challenge.status === 'waiting'
      ? 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300'
      : 'border-primary-500/25 bg-primary-500/10 text-primary-700 dark:text-primary-200';

  return (
    <section aria-labelledby="workstream-overview-title" className="mx-auto w-full max-w-5xl pb-6 [word-break:keep-all] [overflow-wrap:break-word]">
      <button type="button" onClick={onBack} className="mb-3 inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-[12px] font-semibold text-surface-500 transition-colors hover:bg-surface-800 hover:text-surface-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/60">
        <span aria-hidden="true">←</span> {tr('challenge.timeline.title')}
      </button>

      <article className="overflow-hidden rounded-2xl border border-surface-800 bg-surface-900/65 shadow-sm">
        <div className="p-4 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-2 py-1 text-[10px] font-bold ${statusTone}`}>{workstreamStatusLabel(challenge)}</span>
                <span className="text-[11px] text-surface-600">{tr('challenge.timeline.lastUpdated', { project: challenge.projectName, date: formatDateTime(challenge.lastAt) })}</span>
              </div>
              <h2 id="workstream-overview-title" className="mt-3 text-xl font-bold tracking-tight text-surface-100 sm:text-2xl">{challenge.title}</h2>
              <p className="mt-2 max-w-3xl text-[13px] leading-6 text-surface-400">{currentSummary}</p>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-surface-600">
                <span>{tr('challenge.timeline.assignedAi', { names: Array.from(new Set(sessions.map((session) => session.agentName))).join(', ') || tr('challenge.timeline.noRecord') })}</span>
                <span>{tr('challenge.timeline.collaborators', { names: challenge.owners.join(', ') || tr('challenge.timeline.noRecord') })}</span>
                <span>{tr('challenge.timeline.relatedConversationCount', { count: challenge.sessionCount })}</span>
              </div>
            </div>
            <button type="button" disabled={!primarySession} onClick={() => primarySession && openSession(primarySession.id)} className="tone-accent tone-action min-h-11 shrink-0 rounded-xl border px-4 py-2.5 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50">
              {workstreamActionLabel(challenge)}
            </button>
          </div>
        </div>
        <div className="border-t border-surface-800 bg-surface-950/25 px-4 py-4 sm:px-6">
          <div className="flex items-center justify-between text-[11px]"><span className="font-semibold text-surface-400">{tr('challenge.timeline.progressSteps')}</span><span className="tabular-nums text-surface-500">{challenge.todoTotal > 0 ? `${challenge.todoDone}/${challenge.todoTotal}` : tr('challenge.timeline.stepCountMissing')}</span></div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-800"><div className="h-full rounded-full bg-primary-500 transition-[width] motion-reduce:transition-none" style={{ width: `${progress}%` }} /></div>
        </div>
      </article>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(280px,.75fr)]">
        <div className="space-y-4">
          <OverviewSection title={tr('challenge.timeline.currentProgress')} description={tr('challenge.timeline.currentProgressDescription')}>
            <div className="grid gap-3 md:grid-cols-2">
              <TodoOverview title={tr('challenge.timeline.remainingSteps')} todos={openTodos} empty={tr('challenge.timeline.noRemainingSteps')} />
              <TodoOverview title={tr('challenge.timeline.completedSteps')} todos={completedTodos.slice(-8).reverse()} empty={tr('challenge.timeline.noCompletedSteps')} completed />
            </div>
          </OverviewSection>

          <OverviewSection title={tr('challenge.timeline.resultsAndDecisions')} description={tr('challenge.timeline.resultsDescription')}>
            <div className="grid gap-3 md:grid-cols-2">
              <SimpleOverviewList title={tr('challenge.timeline.recentResults')} items={(challenge.outcomes || []).slice(-5).reverse()} empty={tr('challenge.timeline.noResults')} />
              <SimpleOverviewList title={tr('challenge.timeline.openQuestions')} items={(challenge.questions || []).filter((question) => question.status !== 'answered').map((question) => question.title)} empty={tr('challenge.timeline.noOpenQuestions')} />
            </div>
          </OverviewSection>
        </div>

        <aside className="space-y-4">
          <OverviewSection title={tr('challenge.timeline.relatedConversations')} description={tr('challenge.timeline.relatedConversationsDescription')}>
            <div className="divide-y divide-surface-800">
              {sessions.length === 0 ? <p className="py-2 text-[12px] text-surface-600">{tr('challenge.timeline.noRelatedConversations')}</p> : sessions.map((session) => (
                <button key={session.id} type="button" onClick={() => openSession(session.id)} className="block w-full py-2.5 text-left transition-colors hover:text-primary-700 dark:hover:text-primary-200">
                  <span className="block truncate text-[12px] font-semibold text-surface-300">{session.runTitles[session.runTitles.length - 1] || session.name}</span>
                  <span className="mt-0.5 block text-[10px] text-surface-600">{session.agentName} · {formatDateTime(session.lastAt)}</span>
                </button>
              ))}
            </div>
          </OverviewSection>

          <OverviewSection title={tr('challenge.timeline.nextCandidates')} description={tr('challenge.timeline.nextCandidatesDescription')}>
            <SimpleOverviewList items={(challenge.backlog || []).map((item) => item.title)} empty={tr('challenge.timeline.noFollowUps')} />
          </OverviewSection>
        </aside>
      </div>
    </section>
  );
}

function OverviewSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <section className="rounded-2xl border border-surface-800 bg-surface-900/55 p-4 sm:p-5"><h3 className="text-[15px] font-bold text-surface-100">{title}</h3><p className="mt-1 text-[11px] leading-5 text-surface-600">{description}</p><div className="mt-3">{children}</div></section>;
}

function TodoOverview({ title, todos, empty, completed = false }: { title: string; todos: TodoSummaryItem[]; empty: string; completed?: boolean }) {
  return <div><div className="mb-2 text-[11px] font-bold text-surface-400">{title}</div>{todos.length === 0 ? <p className="text-[11px] text-surface-600">{empty}</p> : <ul className="space-y-2">{todos.slice(0, 8).map((todo) => <li key={`${todo.status}:${todo.content}`} className="flex gap-2 text-[12px] leading-5 text-surface-300"><span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${completed ? 'bg-emerald-500' : todo.status === 'in_progress' ? 'bg-amber-500' : 'bg-surface-600'}`} aria-hidden="true"/><span>{todo.content}</span></li>)}</ul>}</div>;
}

function SimpleOverviewList({ title, items, empty }: { title?: string; items: string[]; empty: string }) {
  return <div>{title && <div className="mb-2 text-[11px] font-bold text-surface-400">{title}</div>}{items.length === 0 ? <p className="text-[11px] text-surface-600">{empty}</p> : <ul className="space-y-2 text-[12px] leading-5 text-surface-300">{items.map((item) => <li key={item}>• {item}</li>)}</ul>}</div>;
}

function Stat({ label, value, tone = 'gray' }: { label: string; value: number; tone?: 'gray' | 'primary' | 'amber' }) {
  const toneClass = tone === 'primary' ? 'text-primary-700 dark:text-primary-300' : tone === 'amber' ? 'text-amber-700 dark:text-amber-300' : 'text-surface-100';
  return (
    <div className="rounded-lg border border-surface-800 bg-surface-900/45 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-[0.12em] text-surface-600">{label}</div>
      <div className={`mt-0.5 text-[16px] font-semibold tabular-nums ${toneClass}`}>{value}</div>
    </div>
  );
}

function ProjectTimeline({ project, start, end, expandedIds, onToggle }: { project: ProjectGroup; start: string; end: string; expandedIds: Set<string>; onToggle: (id: string) => void }) {
  const dayTicks = React.useMemo(() => midnightTicks(start, end), [start, end]);

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-[17px] font-semibold tracking-tight text-surface-100">{project.name}</h2>
        <span className="text-[12px] text-surface-600">{project.challengeCount} workstreams · {project.todoLeft} left</span>
      </div>
      <div className="max-w-full overscroll-x-contain overflow-x-auto rounded-2xl border border-surface-800 bg-surface-900/55">
        <div className="min-w-[1060px]">
          <div className="grid grid-cols-[360px_1fr_96px] border-b border-surface-800 bg-surface-950/65 text-[11px] text-surface-600">
            <div className="border-r border-surface-800 px-3 py-1.5 text-left">Workstream</div>
            <div className="relative min-h-7 border-r border-surface-800 px-3 py-1.5">
              {dayTicks.map((tick) => (
                <span key={tick} className="absolute top-1.5 -translate-x-1/2 whitespace-nowrap text-[10px] text-surface-600" style={tickStyle(tick, start, end)}>
                  {formatDateTick(tick)}
                </span>
              ))}
            </div>
            <div className="px-3 py-1.5 text-center">Status</div>
          </div>
          {project.challenges.map((challenge) => (
            <ChallengeLine key={challenge.id} challenge={challenge} start={start} end={end} expanded={expandedIds.has(challenge.id)} onToggle={() => onToggle(challenge.id)} />
          ))}
        </div>
      </div>
    </section>
  );
}

function ChallengeLine({ challenge, start, end, expanded, onToggle }: { challenge: ChallengeRow; start: string; end: string; expanded: boolean; onToggle: () => void }) {
  const followUpCount = challenge.backlog?.length || 0;
  const questionCount = challenge.questions?.length || 0;
  const sessions = challenge.sessions || [];

  return (
    <div id={`workstream-${challenge.workstreamKey || challenge.id}`} className={`scroll-mt-20 border-b border-surface-800 last:border-b-0 ${challenge.status === 'resolved' ? 'bg-emerald-950/10 opacity-85' : 'bg-surface-900/35'}`}>
      <div className="grid min-h-[44px] grid-cols-[360px_1fr_96px]">
        <button type="button" onClick={onToggle} className="min-w-0 border-r border-surface-800 px-3 py-2 text-left transition-colors hover:bg-surface-800/35" title={`${challenge.projectName} · ${challenge.owners.join(', ')} · ${challenge.sessionCount} sessions`}>
          <div className="flex min-w-0 items-center gap-2">
            <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-surface-700 text-[12px] text-surface-500 transition-transform ${expanded ? 'rotate-90 border-primary-400/50 text-primary-700 dark:text-primary-200' : ''}`}>›</span>
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium text-surface-200">{challenge.title}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-surface-600">
                <span>{challenge.sessionCount} sessions</span>
                {followUpCount > 0 && <span className="rounded-full bg-primary-500/10 px-1.5 py-0.5 text-primary-700 dark:text-primary-200">{followUpCount} follow-ups</span>}
                {questionCount > 0 && <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-amber-700 dark:text-amber-200">{questionCount} questions</span>}
              </div>
            </div>
          </div>
        </button>
        <div className="relative border-r border-surface-800 bg-[repeating-linear-gradient(90deg,transparent_0,transparent_calc(8.333%-1px),rgba(44,53,68,.28)_calc(8.333%-1px),rgba(44,53,68,.28)_8.333%)]">
          {challenge.segments.map((segment, index) => (
            <div
              key={`${segment.start}-${index}`}
              className={`absolute top-[10px] flex h-[24px] min-w-[18px] items-center justify-center rounded-sm border px-2 text-[10px] font-bold shadow-sm shadow-black/20 ${segmentClass(segment.kind)}`}
              style={segmentStyle(segment, start, end)}
              title={`${formatDateTime(segment.start)} → ${formatDateTime(segment.end)} · ${tr('challenge.timeline.progressSnapshotCount', { count: segment.snapshotCount })}`}
            >
              {segment.snapshotCount > 1 ? segment.snapshotCount : ''}
            </div>
          ))}
        </div>
        <div className="grid place-items-center px-2 py-2 text-center">
          <div>
            <div className={`text-[12px] font-semibold ${challenge.status === 'resolved' ? 'text-emerald-700 dark:text-emerald-300' : challenge.status === 'active' ? 'text-amber-700 dark:text-amber-300' : 'text-red-700 dark:text-red-300'}`}>{statusText(challenge)}</div>
            <div className="mt-0.5 text-[10px] text-surface-600">{challenge.todoTotal > 0 ? `${challenge.todoDone}/${challenge.todoTotal}` : tr('challenge.timeline.stepCountMissing')}</div>
          </div>
        </div>
      </div>
      {expanded && <WorkstreamDetail challenge={challenge} sessions={sessions} />}
    </div>
  );
}

function WorkstreamDetail({ challenge, sessions }: { challenge: ChallengeRow; sessions: WorkSession[] }) {
  const recentRuns = challenge.runTitles || [];
  const outcomes = challenge.outcomes || [];
  const backlog = challenge.backlog || [];
  const questions = challenge.questions || [];
  const [activeTab, setActiveTab] = React.useState<'runs' | 'backlog' | 'questions'>('runs');
  const [expandedSessionIds, setExpandedSessionIds] = React.useState<Set<string>>(() => new Set());

  const toggleSession = React.useCallback((id: string) => {
    setExpandedSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="border-t border-surface-800 bg-surface-950/45 px-4 py-4">
      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-5">
        <MiniStat label="Sessions" value={challenge.sessionCount} />
        <MiniStat label="Snapshots" value={challenge.segments.reduce((sum, segment) => sum + segment.snapshotCount, 0)} />
        <MiniStat label="Todo left" value={challenge.todoLeft} tone={challenge.todoLeft === 0 ? 'green' : 'amber'} />
        <MiniStat label="Backlog" value={backlog.length} tone={backlog.length > 0 ? 'primary' : 'gray'} />
        <MiniStat label="Questions" value={questions.length} tone={questions.length > 0 ? 'amber' : 'gray'} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.35fr_0.9fr]">
        <section>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-surface-500">Session breakdown</h3>
            <span className="text-[11px] text-surface-600">{tr('challenge.timeline.sessionRowHint')}</span>
          </div>
          <div className="space-y-2">
            {sessions.length === 0 ? (
              <EmptyDetail text={tr('challenge.timeline.noSessionInfo')} />
            ) : sessions.map((session) => (
              <SessionCard key={session.id} session={session} expanded={expandedSessionIds.has(session.id)} onToggle={() => toggleSession(session.id)} />
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-surface-800 bg-surface-900/50 p-3">
          <div className="mb-3 flex rounded-lg border border-surface-800 bg-surface-950/55 p-1 text-[12px]">
            <InspectorTab active={activeTab === 'runs'} onClick={() => setActiveTab('runs')}>Runs</InspectorTab>
            <InspectorTab active={activeTab === 'backlog'} onClick={() => setActiveTab('backlog')}>Backlog {backlog.length ? `· ${backlog.length}` : ''}</InspectorTab>
            <InspectorTab active={activeTab === 'questions'} onClick={() => setActiveTab('questions')}>Questions {questions.length ? `· ${questions.length}` : ''}</InspectorTab>
          </div>

          {activeTab === 'runs' && (
            <div className="space-y-3">
              <DetailCard title={tr('challenge.timeline.recentRuns')} empty={tr('challenge.timeline.noRunTitles')}>
                {recentRuns.map((title) => <li key={title} className="text-surface-300">{title}</li>)}
              </DetailCard>
              <DetailCard title={tr('challenge.timeline.outcomes')} empty={tr('challenge.timeline.noOutcomes')}>
                {outcomes.map((outcome) => <li key={outcome} className="text-surface-300">{outcome}</li>)}
              </DetailCard>
            </div>
          )}
          {activeTab === 'backlog' && (
            <DetailCard title={tr('challenge.timeline.backlog')} empty={tr('challenge.timeline.noBacklog')}>
              {backlog.map((item) => (
                <li key={item.title} className="text-surface-300">
                  <span className="font-medium text-surface-200">{item.title}</span>
                  <span className="ml-2 text-[11px] text-surface-600">{[item.priority, item.type].filter(Boolean).join(' · ')}</span>
                  {item.reason && <div className="mt-0.5 text-[11px] text-surface-600">{item.reason}</div>}
                </li>
              ))}
            </DetailCard>
          )}
          {activeTab === 'questions' && (
            <DetailCard title={tr('challenge.timeline.questions')} empty={tr('challenge.timeline.noOpenQuestions')}>
              {questions.map((question) => (
                <li key={question.title} className="text-surface-300">
                  <span className="font-medium text-surface-200">{question.title}</span>
                  {question.status && <span className="ml-2 text-[11px] text-amber-700 dark:text-amber-300">{question.status}</span>}
                  {question.reason && <div className="mt-0.5 text-[11px] text-surface-600">{question.reason}</div>}
                </li>
              ))}
            </DetailCard>
          )}
        </section>
      </div>
    </div>
  );
}

function MiniStat({ label, value, tone = 'gray' }: { label: string; value: number; tone?: 'gray' | 'primary' | 'amber' | 'green' }) {
  const toneClass = tone === 'primary' ? 'text-primary-700 dark:text-primary-200' : tone === 'amber' ? 'text-amber-700 dark:text-amber-300' : tone === 'green' ? 'text-emerald-700 dark:text-emerald-300' : 'text-surface-200';
  return (
    <div className="rounded-xl border border-surface-800 bg-surface-900/55 px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.14em] text-surface-600">{label}</div>
      <div className={`mt-1 text-[16px] font-semibold tabular-nums ${toneClass}`}>{value}</div>
    </div>
  );
}

function InspectorTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={`flex-1 rounded-md px-2 py-1.5 font-medium transition-colors ${active ? 'bg-primary-500/15 text-primary-700 dark:text-primary-200' : 'text-surface-500 hover:text-surface-300'}`}>
      {children}
    </button>
  );
}

function SessionCard({ session, expanded, onToggle }: { session: WorkSession; expanded: boolean; onToggle: () => void }) {
  const openTodos = session.openTodos || [];
  const completedTodos = session.completedTodos || [];
  return (
    <div className="rounded-xl border border-surface-800 bg-surface-900/70 transition-colors hover:border-surface-700">
      <button type="button" onClick={onToggle} className="w-full p-3 text-left">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 gap-2">
            <span className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-surface-700 text-[12px] text-surface-500 transition-transform ${expanded ? 'rotate-90 border-primary-400/50 text-primary-700 dark:text-primary-200' : ''}`}>›</span>
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold text-surface-200">{session.name}</div>
              <div className="mt-1 text-[11px] text-surface-600">{session.owner} · last {formatDateTime(session.lastAt)} · {session.snapshotCount} snapshots</div>
              {session.runTitles.length > 0 && !expanded && (
                <div className="mt-2 truncate text-[11px] text-surface-500">latest: {session.runTitles[session.runTitles.length - 1]}</div>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-start gap-3">
            <div className="text-right">
              <div className={`text-[12px] font-semibold ${session.todoLeft === 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}`}>{session.todoLeft === 0 ? 'done' : `${session.todoLeft} left`}</div>
              <div className="mt-1 text-[11px] text-surface-600">{session.todoTotal > 0 ? `${session.todoDone}/${session.todoTotal}` : tr('challenge.timeline.stepCountMissing')}</div>
            </div>
            <button type="button" onClick={(event) => { event.stopPropagation(); openSession(session.id); }} className="rounded-lg border border-primary-500/30 bg-primary-500/10 px-2.5 py-1 text-[11px] font-semibold text-primary-700 dark:text-primary-200 transition-colors hover:bg-primary-500/20">
              Open ↗
            </button>
          </div>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-surface-800 px-4 pb-3 pt-2">
          {session.runTitles.length > 0 && (
            <div className="mb-3">
              <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-surface-600">Runs</div>
              <div className="flex flex-wrap gap-1">
                {session.runTitles.map((title) => <span key={title} className="max-w-[260px] truncate rounded-full bg-surface-800 px-2 py-0.5 text-[10px] text-surface-400">{title}</span>)}
              </div>
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <TodoListPreview title={tr('challenge.timeline.openTodos')} todos={openTodos} empty={tr('challenge.timeline.noOpenTodos')} />
            <TodoListPreview title={tr('challenge.timeline.completedSample')} todos={completedTodos} empty={tr('challenge.timeline.noCompletedSample')} />
          </div>
        </div>
      )}
    </div>
  );
}

function TodoListPreview({ title, todos, empty }: { title: string; todos: TodoSummaryItem[]; empty: string }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-surface-600">{title}</div>
      {todos.length === 0 ? <div className="text-[11px] text-surface-600">{empty}</div> : (
        <ul className="space-y-1 text-[11px] text-surface-400">
          {todos.map((todo) => <li key={`${todo.status}:${todo.content}`} className="truncate">• {todo.content}</li>)}
        </ul>
      )}
    </div>
  );
}

function DetailCard({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const hasItems = React.Children.count(children) > 0;
  return (
    <div className="rounded-xl border border-surface-800 bg-surface-900/50 p-3">
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-surface-500">{title}</h3>
      {hasItems ? <ul className="space-y-2 text-[12px] leading-5">{children}</ul> : <EmptyDetail text={empty} />}
    </div>
  );
}

function EmptyDetail({ text }: { text: string }) {
  return <div className="rounded-lg border border-dashed border-surface-800 bg-surface-950/40 px-3 py-2 text-[12px] text-surface-600">{text}</div>;
}
