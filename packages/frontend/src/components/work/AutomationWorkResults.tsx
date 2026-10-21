import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../stores/project-store';
import { useFileStore } from '../../stores/file-store';
import { useSessionStore } from '../../stores/session-store';
import { AutomationResultsPanel, type AutomationResultItem } from '../schedule/AutomationResultsPanel';

/** Project-scoped Run results; does not merge Session unread counts with Run receipts. */
export function AutomationWorkResults() {
  const { t } = useTranslation('schedule');
  const projects = useProjectStore(state => state.projects);
  const openSystemTab = useFileStore(state => state.openSystemTab);
  const [projectId, setProjectId] = useState('');
  const [items, setItems] = useState<AutomationResultItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const sequence = useRef(0);
  const visibleProjects = projects.filter(project => !project.archived && (!project.lifecycleStatus || project.lifecycleStatus === 'active'));
  const selectedProject = visibleProjects.some(project => project.id === projectId) ? projectId : '';
  useEffect(() => {
    const request = ++sequence.current;
    const controller = new AbortController();
    setItems([]); setError(null);
    if (!selectedProject) { setLoading(false); return () => { sequence.current++; controller.abort(); }; }
    setLoading(true);
    const token = localStorage.getItem('token');
    const query = new URLSearchParams({ projectId: selectedProject, limit: '20' });
    fetch(`/api/automations/results?${query}`, { signal: controller.signal, headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(async response => {
        if (!response.ok) throw new Error(t('resultsLoadFailed'));
        const result = await response.json();
        if (request === sequence.current && !controller.signal.aborted) setItems(Array.isArray(result.items) ? result.items : []);
      })
      .catch(() => { if (request === sequence.current && !controller.signal.aborted) setError(t('resultsLoadFailed')); })
      .finally(() => { if (request === sequence.current && !controller.signal.aborted) setLoading(false); });
    return () => { sequence.current++; controller.abort(); };
  }, [selectedProject, refresh, t]);
  return <section className="border-b border-surface-800 p-4" data-testid="automation-work-results">
    <label className="mb-3 block text-[12px] text-surface-400">{t('workResultsProject')}
      <select aria-label={t('workResultsProject')} value={selectedProject} onChange={event => setProjectId(event.target.value)} className="mt-1 w-full rounded-lg border border-surface-700 bg-surface-950 px-2 py-2 text-[13px] text-surface-200">
        <option value="">{t('resultsSelectProject')}</option>
        {visibleProjects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
    </label>
    <AutomationResultsPanel items={items} loading={loading} error={error} projectRequired={!selectedProject}
      projectById={new Map(visibleProjects.map(project => [project.id, { name: project.name }]))}
      onRetry={() => setRefresh(value => value + 1)}
      onSelect={item => openSystemTab('schedule', { refId: item.automationId, title: item.automationName, icon: '⏰' })}
      onOpenSession={sessionId => {
        const store = useSessionStore.getState();
        store.setActiveView('chat'); store.setActiveSessionId(sessionId);
      }} />
  </section>;
}
