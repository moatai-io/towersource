import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Automation, AutomationRun, ProcessMap } from '@tower/shared';
import { useProjectStore } from '../../stores/project-store';
import { useFileStore } from '../../stores/file-store';
import { ProcessMapPreview, duration, jobTypeLabel, triggerLabel } from './SchedulePanel';
import { AutomationWorkbenchModal } from '../../features/automation-workbench/AutomationWorkbenchModal';

const API = '/api/automations';

type FetchOpts = RequestInit & { suppressError?: boolean };

async function fetchJson<T>(url: string, opts?: FetchOpts): Promise<T> {
  const token = localStorage.getItem('token');
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
}

function statusText(job: Automation, t: (key: string) => string): string {
  if (!job.enabled) return t('disabled');
  if (job.status === 'running') return t('running');
  if ((job.lastStatus === 'failed' || job.lastStatus === 'timeout') || job.status === 'failed') return t('failed');
  return t('healthy');
}

export function ScheduleTabView({ automationId, tabId }: { automationId: string; tabId?: string }) {
  const { t } = useTranslation('schedule');
  const projects = useProjectStore((s) => s.projects);
  const closeSystemTab = useFileStore((s) => s.closeSystemTab);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  const [job, setJob] = useState<Automation | null>(null);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [processMap, setProcessMap] = useState<ProcessMap | null>(null);
  const [processMapRunId, setProcessMapRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [processMapLoading, setProcessMapLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProcessMap = useCallback(async (jobId: string, runId: string) => {
    try {
      setProcessMapLoading(true);
      setProcessMapRunId(runId);
      const data = await fetchJson<ProcessMap>(`${API}/${jobId}/runs/${runId}/process-map`);
      setProcessMap(data);
    } catch {
      setProcessMap(null);
    } finally {
      setProcessMapLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [jobData, runData] = await Promise.all([
        fetchJson<Automation>(`${API}/${automationId}`),
        fetchJson<AutomationRun[]>(`${API}/${automationId}/runs?limit=8`),
      ]);
      setJob(jobData);
      setRuns(runData);
      setError(null);
      if (runData[0]) void loadProcessMap(automationId, runData[0].id);
      else {
        setProcessMap(null);
        setProcessMapRunId(null);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [automationId, loadProcessMap]);

  // Keep unattended executions visible without polling hidden tabs.
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const handleRunNow = async () => {
    if (!job || running) return;
    setRunning(true);
    try {
      await fetchJson(`${API}/${job.id}/run-now`, { method: 'POST' });
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  };

  if (loading) return <div className="grid h-full place-items-center text-sm text-surface-500">{t('loading')}</div>;
  if (error && !job) return <div className="grid h-full place-items-center text-sm text-red-300">{error}</div>;
  if (!job) return <div className="grid h-full place-items-center text-sm text-surface-500">{t('notFound')}</div>;

  const projectName = job.projectId ? projectById.get(job.projectId)?.name : t('systemJobs');

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-950">
      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-surface-800 px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-lg">⏰</span>
            <h1 className="truncate text-lg font-bold text-surface-100">{job.name}</h1>
            <span className="rounded-full border border-primary-600/25 bg-primary-50 px-2 py-0.5 text-[11px] font-bold text-primary-800 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-200">{t('schedule')}</span>
          </div>
          <p className="mt-1 text-[13px] text-surface-500">{triggerLabel(job, (key: string, opts?: any) => opts?.defaultValue || key)} · {jobTypeLabel(job.jobType, (key: string, opts?: any) => opts?.defaultValue || key)} · {projectName}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button disabled={running} onClick={handleRunNow} className="rounded-lg bg-primary-600 px-3 py-2 text-[13px] font-semibold text-white hover:bg-primary-500 disabled:opacity-50 dark:bg-primary-500 dark:hover:bg-primary-400">{running ? t('running') : `▶ ${t('runNow')}`}</button>
          {tabId && <button onClick={() => closeSystemTab(tabId)} className="rounded-lg bg-surface-800 px-3 py-2 text-[13px] font-semibold text-surface-300 hover:bg-surface-700">{t('closeTab')}</button>}
        </div>
      </div>

      {error && <div className="mx-5 mt-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">{error}</div>}

      <main className="flex-1 min-h-0 overflow-y-auto p-5">
        <div className="mx-auto max-w-[1500px] space-y-4">
          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded-2xl border border-surface-800 bg-surface-900/50 p-3">
              <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-surface-500">{t('status')}</div>
              <div className="mt-1 text-sm font-semibold text-surface-100">{statusText(job, t)}</div>
            </div>
            <div className="rounded-2xl border border-surface-800 bg-surface-900/50 p-3">
              <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-surface-500">{t('nextRun')}</div>
              <div className="mt-1 truncate text-sm font-semibold text-surface-100">{job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : '-'}</div>
            </div>
            <div className="rounded-2xl border border-surface-800 bg-surface-900/50 p-3">
              <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-surface-500">{t('runs')}</div>
              <div className="mt-1 text-sm font-semibold text-surface-100">{job.runCount}</div>
            </div>
            <div className="rounded-2xl border border-surface-800 bg-surface-900/50 p-3">
              <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-surface-500">{t('risk')}</div>
              <div className="mt-1 text-sm font-semibold text-surface-100">{job.riskLevel}</div>
            </div>
          </div>

          <AutomationWorkbenchModal
            automation={job}
            embedded
            onOpenLegacyEdit={() => {}}
          />

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="rounded-2xl border border-surface-800 bg-surface-900/50 p-4">
              <ProcessMapPreview
                map={processMap}
                loading={processMapLoading}
                onReload={() => { if (job && processMapRunId) void loadProcessMap(job.id, processMapRunId); }}
              />
            </div>
            <div className="rounded-2xl border border-surface-800 bg-surface-900/50 p-3">
              <div className="text-[12px] uppercase tracking-wider font-bold text-surface-500 mb-2">{t('runLog')}</div>
              {runs.length === 0 ? <div className="text-[13px] text-surface-500">{t('noRuns')}</div> : (
                <div className="space-y-2">
                  {runs.map((run) => (
                    <button key={run.id} onClick={() => loadProcessMap(job.id, run.id)} className={`w-full rounded-xl border px-3 py-2 text-left text-[12px] ${processMapRunId === run.id ? 'border-primary-600/45 bg-primary-50 text-primary-800 dark:border-primary-500/60 dark:bg-primary-500/15 dark:text-primary-100' : 'border-surface-750 bg-surface-850 text-surface-300 hover:border-surface-650'}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold">{run.status === 'success' ? t('success') : run.status === 'failed' ? t('failed') : run.status}</span>
                        <span className="text-surface-500">{duration(run)}</span>
                      </div>
                      <div className="mt-0.5 text-surface-500">{new Date(run.ranAt).toLocaleString()}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
