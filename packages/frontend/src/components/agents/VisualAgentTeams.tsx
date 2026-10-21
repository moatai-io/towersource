import React from 'react';
import type { Project } from '@tower/shared';
import { useTranslation } from 'react-i18next';
import { AgentIdentityAvatar } from '../../features/agent-profile/AgentIdentityAvatar';

type Snapshot = { version: number; teams: { id: string; name: string }[]; assignments: Record<string, string>; canManage: boolean };
const control = 'min-h-11 rounded-lg border border-surface-700 bg-surface-900 px-3 py-2 text-sm text-surface-200 focus-visible:ring-2 focus-visible:ring-primary-400 disabled:opacity-50';
const headers = () => ({ Authorization: `Bearer ${localStorage.getItem('token') || ''}`, 'Content-Type': 'application/json' });
function snapshot(value: unknown): Snapshot {
  const data = value as Snapshot;
  if (!data || !Number.isInteger(data.version) || data.version < 0 || typeof data.canManage !== 'boolean'
    || !Array.isArray(data.teams) || !data.teams.every(team => team && typeof team.id === 'string' && typeof team.name === 'string')
    || !data.assignments || typeof data.assignments !== 'object' || Array.isArray(data.assignments)
    || !Object.values(data.assignments).every(teamId => typeof teamId === 'string')) throw new Error('invalid');
  return data;
}

/** Organization-wide visual labels only. Never uses authority-team APIs. */
export function VisualAgentTeams({ projects }: { projects: Project[] }) {
  const { t } = useTranslation('layout');
  const [data, setData] = React.useState<Snapshot | null>(null);
  const [phase, setPhase] = React.useState<'loading' | 'ready' | 'error' | 'forbidden'>('loading');
  const [revision, reload] = React.useReducer(n => n + 1, 0);
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const inFlight = React.useRef(false);
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  React.useEffect(() => {
    const controller = new AbortController();
    setPhase('loading');
    fetch('/api/agent-visual-teams', { headers: headers(), signal: controller.signal }).then(async response => {
      if (response.status === 403) { if (!controller.signal.aborted) setPhase('forbidden'); return; }
      if (!response.ok) throw new Error('load');
      const next = snapshot(await response.json());
      if (!controller.signal.aborted) { setData(next); setPhase('ready'); }
    }).catch(() => { if (!controller.signal.aborted) setPhase('error'); });
    return () => controller.abort();
  }, [revision]);
  async function change(command: { kind: 'create'; name: string } | { kind: 'assign'; projectId: string; teamId: string | null }) {
    if (!data?.canManage || inFlight.current || phase !== 'ready') return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const response = await fetch('/api/agent-visual-teams', { method: 'PATCH', headers: headers(), body: JSON.stringify({ expectedVersion: data.version, command }) });
      if (response.status === 409) { if (mounted.current) { setError(t('visualAgentTeams.conflict')); reload(); } return; }
      if (!response.ok) throw new Error('save');
      const next = snapshot(await response.json());
      if (mounted.current) { setData(next); if (command.kind === 'create') setName(''); }
    } catch { if (mounted.current) { setError(t('visualAgentTeams.saveError')); setPhase('error'); } }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  if (phase === 'forbidden') return null;
  const groups = data ? [...data.teams, { id: '', name: t('visualAgentTeams.unassigned') }] : [];
  return <section className="mt-5 rounded-xl border border-surface-700/70 p-4" aria-label={t('visualAgentTeams.title')}>
    <h2 className="text-base font-semibold text-surface-100">{t('visualAgentTeams.title')}</h2>
    <p className="mt-1 text-sm leading-6 text-surface-500">{t('visualAgentTeams.boundary')}</p>
    {phase === 'loading' && <p role="status" className="mt-3 text-sm text-surface-500">{t('visualAgentTeams.loading')}</p>}
    {phase === 'error' && <p role="alert" className="mt-3 text-sm text-surface-300">{t('visualAgentTeams.loadError')} <button type="button" className={control} onClick={reload}>{t('visualAgentTeams.retry')}</button></p>}
    {error && <p role="alert" className="mt-3 text-sm text-surface-300">{error}</p>}
    {phase === 'ready' && data && <>
      {data.canManage && <form className="mt-4 flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); if (name.trim()) void change({ kind: 'create', name: name.trim() }); }}>
        <input aria-label={t('visualAgentTeams.teamName')} placeholder={t('visualAgentTeams.teamName')} value={name} onChange={event => setName(event.target.value)} maxLength={80} disabled={busy} className={control} />
        <button type="submit" disabled={busy || !name.trim()} className={control}>{t('visualAgentTeams.create')}</button>
      </form>}
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {groups.map(group => {
          const agents = projects.filter(project => (data.assignments[project.id] || '') === group.id);
          return <section key={group.id} className="min-w-0 rounded-lg border border-surface-800 p-3" aria-label={group.name}>
            <h3 className="flex justify-between gap-2 text-sm font-semibold text-surface-200"><span className="break-words">{group.name}</span><span className="text-surface-500">{agents.length}</span></h3>
            {agents.length === 0 && <p className="mt-3 text-xs text-surface-500">{t('visualAgentTeams.empty')}</p>}
            <ul className="mt-2 space-y-2">{agents.map(project => <li key={project.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-900/50 p-2">
              <AgentIdentityAvatar project={project} className="h-9 w-9 shrink-0 rounded-lg" />
              <span className="min-w-0 flex-1 break-words text-sm text-surface-200">{project.agent?.displayName || project.name}</span>
              {data.canManage && <select aria-label={t('visualAgentTeams.move', { name: project.agent?.displayName || project.name })} value={group.id} disabled={busy} onChange={event => void change({ kind: 'assign', projectId: project.id, teamId: event.target.value || null })} className={`${control} max-w-full`}>
                {groups.map(target => <option key={target.id} value={target.id}>{target.name}</option>)}
              </select>}
            </li>)}</ul>
          </section>;
        })}
      </div>
      {busy && <p role="status" className="mt-2 text-xs text-surface-500">{t('visualAgentTeams.saving')}</p>}
    </>}
  </section>;
}
