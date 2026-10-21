import React from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentDirectoryEntry, Project } from '@tower/shared';
import { AgentCharacterAvatar, distributedKoreanCharacterId } from '../agent-profile/characters';

const headers = () => ({ Authorization: `Bearer ${localStorage.getItem('token') || ''}` });

/** Directory rows remain discovery DTOs, never fabricated Project store entries. */
export function AgentDirectory({ projects, onOpenProject, integrated = false, searchQuery = '' }: { projects: Project[]; onOpenProject: (project: Project) => void; integrated?: boolean; searchQuery?: string }) {
  const { t, i18n } = useTranslation('layout');
  const [agents, setAgents] = React.useState<AgentDirectoryEntry[]>([]);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [revision, refresh] = React.useReducer(n => n + 1, 0);
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState<string | null>(null);
  const [opening, setOpening] = React.useState<string | null>(null);
  const [entryError, setEntryError] = React.useState(false);
  React.useEffect(() => {
    const controller = new AbortController();
    setStatus('loading'); setAgents([]); setSelected(null);
    fetch('/api/agent-directory', { headers: headers(), signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('unavailable');
      const data = await response.json();
      if (!controller.signal.aborted) { setAgents(data.agents || []); setStatus('ready'); }
    }).catch(() => { if (!controller.signal.aborted) setStatus('error'); });
    return () => controller.abort();
  }, [revision]);
  React.useEffect(() => {
    window.addEventListener('focus', refresh);
    window.addEventListener('tower-agent-directory-changed', refresh);
    window.addEventListener('tower-administrator-participation-changed', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('tower-agent-directory-changed', refresh);
      window.removeEventListener('tower-administrator-participation-changed', refresh);
    };
  }, []);
  async function open(agent: AgentDirectoryEntry) {
    if (agent.access === 'contact') { setSelected(agent.projectId); return; }
    setOpening(agent.projectId); setEntryError(false);
    try {
      // Re-resolve through the existing ACL-filtered endpoint, even if a cached
      // Project exists. Directory access labels never authorize workspace entry.
      const response = await fetch('/api/projects', { headers: headers() });
      if (!response.ok) throw new Error('unavailable');
      const accessible: Project[] = await response.json();
      const project = accessible.find(p => p.id === agent.projectId && !p.archived && !p.systemKey);
      if (!project) throw new Error('access changed');
      onOpenProject(project);
    } catch { setEntryError(true); }
    finally { setOpening(null); }
  }
  const normalized = (integrated ? searchQuery : query).trim().toLocaleLowerCase(i18n.language);
  const visible = agents.filter(agent => (!integrated || !projects.some(project => project.id === agent.projectId)) && [agent.name, agent.shortRole, agent.contactName].some(value => value?.toLocaleLowerCase(i18n.language).includes(normalized)));
  // projects is intentionally not merged into agents: hidden/confidential rows
  // belong only to the existing authorized management surface below this section.
  if (integrated) return <>
    {status === 'error' && <p role="alert" className="col-span-full text-sm text-surface-400">{t('agentDirectory.error')} <button type="button" onClick={refresh}>{t('agentDirectory.refresh')}</button></p>}
    {entryError && <p role="alert" className="col-span-full text-sm text-surface-300">{t('agentDirectory.entryError')}</p>}
    {visible.map(agent => <article key={agent.projectId} className="rounded-xl border border-surface-700/70 bg-surface-900/45 p-4">
      <div className="flex items-center gap-3"><AgentCharacterAvatar id={distributedKoreanCharacterId(agent.projectId)} title={agent.name} className="h-20 w-20 shrink-0 rounded-xl" /><div><h3 className="font-semibold text-surface-100">{agent.name}</h3><p className="text-xs text-surface-400">{agent.shortRole}</p></div></div>
      <p className="mt-3 text-xs text-surface-400">{agent.contactName || t('agentDirectory.noContact')}</p>
      <button type="button" disabled={opening !== null} onClick={() => void open(agent)} className="mt-4 min-h-11 w-full rounded-md border border-surface-700 px-3 py-2 text-sm text-surface-200 focus-visible:ring-2 focus-visible:ring-primary-400 disabled:opacity-50">{t(agent.access === 'contact' ? 'agentDirectory.introduction' : agent.access === 'enter' ? 'aiTeamGrouping.enter' : 'agentDirectory.open')}</button>
      {selected === agent.projectId && agent.access === 'contact' && <p role="status" className="mt-3 text-sm text-surface-300">{t('agentDirectory.askContact', { name: agent.contactName || t('agentDirectory.noContact') })}</p>}
    </article>)}
  </>;
  return <section className="mt-5 min-w-0 border-y border-surface-800 py-4 [word-break:keep-all] [overflow-wrap:break-word]" aria-labelledby="company-agent-directory-title">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 id="company-agent-directory-title" className="text-base font-semibold text-surface-200">{t('agentDirectory.title')}</h3>
      <button type="button" onClick={refresh} disabled={status === 'loading'} className="rounded px-2 py-1 text-xs text-surface-400 focus-visible:ring-2 focus-visible:ring-primary-400 disabled:opacity-50">{t('agentDirectory.refresh')}</button>
    </div>
    <p className="mt-1 text-sm leading-6 text-surface-400">{t('agentDirectory.description')}</p>
    <input type="search" value={query} onChange={event => setQuery(event.target.value)} aria-label={t('agentDirectory.search')} placeholder={t('agentDirectory.search')} className="mt-3 w-full rounded-lg border border-surface-700 bg-surface-900 px-3 py-2 text-sm text-surface-200 sm:max-w-md" />
    {status === 'loading' && <p role="status" className="py-3 text-sm text-surface-400">{t('agentDirectory.loading')}</p>}
    {status === 'error' && <p role="alert" className="py-3 text-sm text-surface-300">{t('agentDirectory.error')}</p>}
    {entryError && <p role="alert" className="py-3 text-sm text-surface-300">{t('agentDirectory.entryError')}</p>}
    {status === 'ready' && visible.length === 0 && <p className="py-3 text-sm text-surface-400">{t('agentDirectory.empty')}</p>}
    <ul className="mt-3 divide-y divide-surface-800">
      {visible.map(agent => <li key={agent.projectId} className={`py-4 ${agent.access !== 'available' ? 'bg-surface-800/20' : ''}`}>
        <div className="flex flex-wrap items-start justify-between gap-3 px-2">
          <div className="min-w-0 flex-1">
            <h4 className="break-words text-sm font-semibold text-surface-200">{agent.name}</h4>
            {agent.shortRole && <p className="mt-1 text-sm leading-6 text-surface-400">{agent.shortRole}</p>}
            <p className="mt-1 text-xs leading-5 text-surface-400">{t('agentDirectory.contact')}: {agent.contactName || t('agentDirectory.noContact')}</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <span className="text-xs font-medium text-surface-300">{agent.access === 'contact' && <span aria-hidden="true">🔒 </span>}{t(`agentDirectory.access.${agent.access}`)}</span>
            <button type="button" disabled={opening !== null} aria-expanded={agent.access === 'contact' ? selected === agent.projectId : undefined} onClick={() => void open(agent)} className="rounded-lg border border-surface-700 px-3 py-2 text-xs font-semibold text-surface-200 focus-visible:ring-2 focus-visible:ring-primary-400 disabled:opacity-50">{t(agent.access === 'contact' ? 'agentDirectory.introduction' : 'agentDirectory.open')}</button>
          </div>
        </div>
        {selected === agent.projectId && agent.access === 'contact' && <p role="status" className="mt-3 px-2 text-sm leading-6 text-surface-300">{t('agentDirectory.askContact', { name: agent.contactName || t('agentDirectory.noContact') })}</p>}
      </li>)}
    </ul>
  </section>;
}
