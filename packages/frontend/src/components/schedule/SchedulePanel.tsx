/**
 * SchedulePanel — minimal user-facing Schedule dashboard.
 *
 * V1 UX principle: show two simple lists — upcoming executions and registered
 * schedules — then keep controls/logs in a shared detail pane.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import type { Automation as SharedAutomation, AutomationCronConfig, AutomationRun, AutomationTrigger, ProcessMap, ProcessNodeStatus } from '@tower/shared';
import { useProjectStore } from '../../stores/project-store';
import { useFileStore } from '../../stores/file-store';
import { useSessionStore } from '../../stores/session-store';
import { useAiPanelStore } from '../../stores/ai-panel-store';
import { useConfirm } from '../../hooks/useDialog';
import { normalizeTowerFilePath, openTowerFile } from '../../utils/file-path-links';
import { AutomationResultsPanel, type AutomationResultItem, resultStatus, resultStatusLabel } from './AutomationResultsPanel';
import { AutomationCreatePanel } from './AutomationCreatePanel';

const API = '/api/automations';
type Automation = SharedAutomation & {
  configUpdatedAt?: string;
  configUpdatedByUserId?: number | null;
  runtimeStateJson?: Record<string, unknown>;
};
type ViewMode = 'upcoming' | 'registered' | 'results';
const SCHEDULE_LIST_WIDTH_KEY = 'tower.schedule.listWidth';
const MIN_SCHEDULE_LIST_WIDTH = 420;
const MAX_SCHEDULE_LIST_WIDTH = 760;
type IntervalCronConfig = AutomationCronConfig & { minutes?: number; hours?: number };
type ScheduleOverviewProps = {
  jobs: Automation[];
  allJobs: Automation[];
  upcomingJobs: Automation[];
  registeredJobs: Automation[];
  projectById: Map<string, { name: string }>;
  selectedProjectFilter: string;
  onProjectFilterChange: (projectId: string) => void;
  onSelect: (job: Automation) => void;
  onOpenAiThread: (job: Automation) => void;
  onCreate: () => void;
  latestResult: React.ComponentProps<typeof AutomationResultsPanel>;
  t: (key: string, opts?: any) => string;
};

async function fetchJson<T>(url: string, opts?: RequestInit): Promise<T> {
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

export function jobTypeLabel(type: string, t: (key: string, opts?: any) => string): string {
  switch (type) {
    case 'ai_prompt': return t('jobTypeAi');
    case 'webhook': return t('jobTypeWebhook');
    case 'shell': return t('jobTypeShell');
    case 'script': return t('jobTypeScript');
    case 'monitor': return t('jobTypeMonitor');
    default: return type;
  }
}

export function triggerLabel(a: Automation, t: (key: string, opts?: any) => string): string {
  if (a.triggerType === 'manual') return t('manual');
  if (a.triggerType === 'once') return a.onceAt ? new Date(a.onceAt).toLocaleString() : t('once');
  if (!a.cronConfig) return t('cron');

  const c = a.cronConfig as IntervalCronConfig;
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(c.hour ?? 9)}:${pad(c.minute ?? 0)}`;
  switch (c.type) {
    case 'daily': return `${t('daily')} ${time}`;
    case 'weekdays': return `${t('weekdays')} ${time}`;
    case 'weekly': {
      const days = [t('sun'), t('mon'), t('tue'), t('wed'), t('thu'), t('fri'), t('sat')];
      return `${t('weekly')} ${days[c.day ?? 1]} ${time}`;
    }
    case 'interval': {
      const minutes = c.minutes ?? (c.hours ?? 1) * 60;
      if (minutes % 60 === 0) return t('intervalHours', { count: minutes / 60 });
      return t('intervalMinutes', { count: minutes });
    }
    default: return t('cron');
  }
}

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return '-';
  const diff = Date.now() - new Date(dateStr).getTime();
  const abs = Math.abs(diff);
  const mins = Math.floor(abs / 60000);
  if (mins < 1) return i18n.t(diff >= 0 ? 'relativeTime.justNow' : 'relativeTime.withinMinute', { ns: 'schedule' });
  if (mins < 60) return i18n.t(diff >= 0 ? 'relativeTime.minutesAgo' : 'relativeTime.minutesLater', { ns: 'schedule', count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return i18n.t(diff >= 0 ? 'relativeTime.hoursAgo' : 'relativeTime.hoursLater', { ns: 'schedule', count: hours });
  const days = Math.floor(hours / 24);
  return i18n.t(diff >= 0 ? 'relativeTime.daysAgo' : 'relativeTime.daysLater', { ns: 'schedule', count: days });
}

function dayLabel(dateStr: string | null, t: (key: string, opts?: any) => string): string {
  if (!dateStr) return t('unscheduled');
  const d = new Date(dateStr);
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((target - start) / 86400000);
  if (days === 0) return t('today');
  if (days === 1) return t('tomorrow');
  if (days > 1 && days < 7) return t('thisWeek');
  return d.toLocaleDateString();
}

function timeLabel(dateStr: string | null, t: (key: string, opts?: any) => string): { main: string; sub: string } {
  if (!dateStr) return { main: '-', sub: t('unscheduled') };
  const d = new Date(dateStr);
  return {
    main: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    sub: relativeTime(dateStr),
  };
}

function isCreationDraft(job: Automation): boolean {
  return (job.definitionJson?.creationPlan as { status?: string } | undefined)?.status === 'draft';
}

function statusBadge(a: Automation, t: (key: string, opts?: any) => string): { text: string; cls: string } {
  if (isCreationDraft(a)) return { text: t('draftReview'), cls: 'tone-muted' };
  if (!a.enabled) return { text: t('statusOff'), cls: 'tone-muted' };
  if (a.status === 'running') return { text: t('statusRunning'), cls: 'tone-info' };
  if (a.lastStatus === 'failed' || a.status === 'failed') return { text: t('statusFailed'), cls: 'tone-danger' };
  return { text: t('statusHealthy'), cls: 'tone-success' };
}

function normalizeWorkspacePath(pathValue: string, projectRoot?: string | null): string | null {
  const raw = pathValue.trim().replace(/,$/, '');
  if (!raw || raw.startsWith('-') || raw.includes('://')) return null;
  if (raw.startsWith('/') || raw.startsWith('~/')) return normalizeTowerFilePath(raw);
  if (!projectRoot) return null;
  return `${projectRoot.replace(/\/$/, '')}/${raw.replace(/^\.\//, '')}`;
}

function extractRelatedFiles(job: Automation, projectRoot?: string | null): string[] {
  const def = job.definitionJson || {};
  const values: string[] = [];
  for (const key of ['filePath', 'path', 'scriptPath', 'outputPath', 'inputPath', 'reportPath', 'cwd']) {
    const value = def[key];
    if (typeof value === 'string') values.push(value);
  }
  const command = typeof def.command === 'string' ? def.command : '';
  const script = typeof def.script === 'string' ? def.script : '';
  const matches = `${command} ${script}`.match(/(?:~\/|\/home\/|\.\.?\/|[\w.-]+\/)[^\s'"`]+\.(?:ts|tsx|js|mjs|cjs|py|sh|md|json|yaml|yml|sql|csv|xlsx|html|css|log)/g) || [];
  values.push(...matches);
  const files = values
    .map((v) => normalizeWorkspacePath(v, projectRoot))
    .filter((v): v is string => Boolean(v));
  return Array.from(new Set(files)).slice(0, 6);
}

function ScheduleOverview({ jobs, allJobs, upcomingJobs, registeredJobs, projectById, selectedProjectFilter, onProjectFilterChange, onSelect, onOpenAiThread, onCreate, latestResult, t }: ScheduleOverviewProps) {
  const failedJobs = jobs.filter((job) => job.enabled && (job.lastStatus === 'failed' || job.status === 'failed'));
  const runningJobs = jobs.filter((job) => job.status === 'running');
  const enabledJobs = jobs.filter((job) => job.enabled);
  const recentJobs = [...registeredJobs].slice(0, 4);
  const primaryJob = failedJobs[0] || upcomingJobs[0] || recentJobs[0] || null;
  const statCards = [
    { label: t('enabledAutomations'), value: enabledJobs.length, tone: 'text-teal-700 dark:text-primary-200', helper: t('enabledAutomationsHelp') },
    { label: t('scheduledRuns'), value: upcomingJobs.length, tone: 'text-slate-950 dark:text-surface-100', helper: t('scheduledRunsHelp') },
    { label: t('runningNow'), value: runningJobs.length, tone: 'text-blue-700 dark:text-blue-200', helper: t('runningNowHelp') },
    { label: t('needsAttention'), value: failedJobs.length, tone: failedJobs.length ? 'text-red-700 dark:text-red-200' : 'text-emerald-700 dark:text-emerald-200', helper: t('needsAttentionHelp') },
  ];
  const projectSummaries = Array.from(allJobs.reduce((map, job) => {
    const key = job.projectId || 'system';
    const label = job.projectId ? (projectById.get(job.projectId)?.name || 'Unknown project') : t('systemJobs');
    const current = map.get(key) || { key, label, total: 0, enabled: 0, failed: 0 };
    current.total += 1;
    if (job.enabled) current.enabled += 1;
    if (job.lastStatus === 'failed' || job.status === 'failed') current.failed += 1;
    map.set(key, current);
    return map;
  }, new Map<string, { key: string; label: string; total: number; enabled: number; failed: number }>()).values()).sort((a, b) => b.failed - a.failed || b.total - a.total || a.label.localeCompare(b.label));
  const visibleProjectSummaries = projectSummaries.slice(0, 5);
  const hiddenProjectCount = Math.max(0, projectSummaries.length - visibleProjectSummaries.length);

  const requestExamples = [
    { title: t('exampleChangeTimeTitle'), body: t('exampleChangeTimeBody'), action: primaryJob ? () => onOpenAiThread(primaryJob) : onCreate, tone: 'primary' },
    { title: t('exampleEventOnlyTitle'), body: t('exampleEventOnlyBody'), action: onCreate, tone: 'plain' },
    { title: t('exampleAutomateSkillTitle'), body: t('exampleAutomateSkillBody'), action: onCreate, tone: 'plain' },
  ];

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border border-teal-200 bg-white p-5 shadow-sm dark:border-surface-800 dark:bg-surface-900/65">
        <div className="space-y-4">
          <div className="max-w-3xl">
            <div className="text-[12px] font-bold uppercase tracking-[0.16em] text-teal-700 dark:text-primary-300">{t('homeEyebrow')}</div>
            <h2 className="mt-1 text-xl font-bold text-slate-950 dark:text-surface-100">{t('homeTitle')}</h2>
            <p className="mt-2 text-[14px] leading-6 text-slate-600 dark:text-surface-400">{t('homeDescription')}</p>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 xl:max-w-3xl">
            {primaryJob && (
              <button onClick={() => onOpenAiThread(primaryJob)} className="rounded-2xl bg-teal-700 px-4 py-3 text-left text-white shadow-sm hover:bg-teal-600 dark:bg-primary-500 dark:hover:bg-primary-400">
                <div className="text-[14px] font-bold">{t('editByConversation')}</div>
                <div className="mt-1 truncate text-[12px] text-white/80">{primaryJob.name}</div>
              </button>
            )}
            <button onClick={onCreate} className="rounded-2xl border border-teal-300 bg-teal-50 px-4 py-3 text-left text-teal-950 hover:bg-teal-100 dark:border-primary-500/30 dark:bg-surface-900 dark:text-primary-100 dark:hover:bg-primary-500/10">
              <div className="text-[14px] font-bold">{t('createAutomation')}</div>
              <div className="mt-1 text-[12px] text-teal-700 dark:text-primary-200/80">{t('createFromProjectSession')}</div>
            </button>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {statCards.map((stat) => (
              <div key={stat.label} className="rounded-2xl border border-slate-200 bg-slate-50 p-3 dark:border-surface-800 dark:bg-surface-850/60">
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-surface-500">{stat.label}</div>
                <div className={`mt-1 text-2xl font-black ${stat.tone}`}>{stat.value}</div>
                <div className="mt-1 text-[12px] text-slate-500 dark:text-surface-500">{stat.helper}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-surface-800 bg-surface-900/50 p-4"><AutomationResultsPanel {...latestResult} compact /></div>

      <div className="grid gap-3 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-surface-800 dark:bg-surface-900/50">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-[12px] font-bold uppercase tracking-wider text-slate-500 dark:text-surface-500">{t('filterByProject')}</div>
              <div className="mt-1 text-[12px] text-slate-500 dark:text-surface-500">{t('filterByProjectHelp')}</div>
            </div>
            <div className="text-[12px] text-slate-500 dark:text-surface-500">{t('filter')}</div>
          </div>
          {projectSummaries.length === 0 ? <div className="py-6 text-center text-[13px] text-slate-500 dark:text-surface-500">{t('empty')}</div> : (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <button onClick={() => onProjectFilterChange('all')} className={`rounded-full border px-3 py-1.5 text-[12px] font-semibold ${selectedProjectFilter === 'all' ? 'border-teal-400 bg-teal-50 text-teal-800 dark:border-primary-400/60 dark:bg-primary-500/15 dark:text-primary-100' : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 dark:border-surface-800 dark:bg-surface-850 dark:text-surface-300 dark:hover:border-surface-700'}`}>{t('all')}</button>
                {visibleProjectSummaries.map((project) => (
                  <button key={project.key} onClick={() => onProjectFilterChange(project.key)} className={`rounded-full border px-3 py-1.5 text-[12px] font-semibold ${selectedProjectFilter === project.key ? 'border-teal-400 bg-teal-50 text-teal-800 dark:border-primary-400/60 dark:bg-primary-500/15 dark:text-primary-100' : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 dark:border-surface-800 dark:bg-surface-850 dark:text-surface-300 dark:hover:border-surface-700'}`}>
                    <span>{project.label}</span>
                    <span className="ml-1 text-slate-400 dark:text-surface-500">{project.total}</span>
                    {project.failed > 0 && <span className="ml-1 text-red-600 dark:text-red-300">{t('attentionCount', { count: project.failed })}</span>}
                  </button>
                ))}
              </div>
              {hiddenProjectCount > 0 && (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-2 text-[12px] leading-5 text-slate-500 dark:border-surface-800 dark:bg-surface-850/40 dark:text-surface-500">
                  {t('projectLimitNotice', { visible: visibleProjectSummaries.length, hidden: hiddenProjectCount })}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-surface-800 dark:bg-surface-900/50">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="text-[12px] font-bold uppercase tracking-wider text-slate-500 dark:text-surface-500">{t('recentAutomations')}</div>
            <div className="text-[12px] text-slate-500 dark:text-surface-500">{t('recentSortHelp')}</div>
          </div>
          <div className="space-y-2">
            {recentJobs.map((job) => {
              const projectName = job.projectId ? projectById.get(job.projectId)?.name : t('systemJobs');
              return (
                <button key={job.id} onClick={() => onSelect(job)} className="w-full rounded-xl border border-slate-200 bg-slate-50 p-3 text-left hover:border-teal-300 hover:bg-teal-50 dark:border-surface-800 dark:bg-surface-850/60 dark:hover:border-primary-500/40 dark:hover:bg-primary-500/10">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-semibold text-slate-950 dark:text-surface-100">{job.name}</div>
                      <div className="mt-1 text-[12px] text-slate-500 dark:text-surface-500">{projectName || '-'} · {triggerLabel(job, t)}</div>
                    </div>
                    <span className={`tone-pill shrink-0 rounded px-1.5 py-0.5 text-[11px] ${statusBadge(job, t).cls}`}>{statusBadge(job, t).text}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-surface-800 dark:bg-surface-900/50">
        <div className="mb-3 text-[12px] font-bold uppercase tracking-wider text-slate-500 dark:text-surface-500">{t('requestExamples')}</div>
        <div className="grid gap-2 xl:grid-cols-3">
            {failedJobs.length > 0 && failedJobs.slice(0, 1).map((job) => (
              <button key={job.id} onClick={() => onOpenAiThread(job)} className="w-full rounded-xl border border-red-200 bg-red-50 p-3 text-left text-red-900 hover:bg-red-100 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-100 dark:hover:bg-red-500/15">
                <div className="text-[13px] font-semibold">{t('failedConditionReview')}</div>
                <div className="mt-1 truncate text-[12px] text-red-700 dark:text-red-200/80">{job.name}</div>
              </button>
            ))}
          {requestExamples.map((example) => (
            <button key={example.title} onClick={example.action} className={`rounded-xl border p-3 text-left ${example.tone === 'primary' ? 'border-teal-200 bg-teal-50 text-teal-950 hover:bg-teal-100 dark:border-primary-500/35 dark:bg-primary-500/10 dark:text-primary-100 dark:hover:bg-primary-500/15' : 'border-slate-200 bg-slate-50 text-slate-950 hover:bg-slate-100 dark:border-surface-800 dark:bg-surface-850/60 dark:text-surface-100 dark:hover:border-surface-700'}`}>
              <div className="text-[13px] font-semibold">{example.title}</div>
              <div className={`mt-1 text-[12px] ${example.tone === 'primary' ? 'text-teal-700 dark:text-primary-200/80' : 'text-slate-500 dark:text-surface-500'}`}>{example.body}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function processStepStatusLabel(status: ProcessNodeStatus): string {
  const key = status === 'completed' || status === 'running' || status === 'failed' || status === 'blocked' || status === 'skipped' ? status : 'pending';
  return i18n.t(`processStepStatus.${key}`, { ns: 'schedule' });
}

function processStepTone(status: ProcessNodeStatus): { box: string; text: string; icon: string } {
  switch (status) {
    case 'completed': return { box: 'border-emerald-500/45 bg-emerald-500/15 text-emerald-200', text: 'text-emerald-200', icon: '✓' };
    case 'running': return { box: 'border-blue-400/55 bg-blue-500/15 text-blue-200', text: 'text-blue-200', icon: '…' };
    case 'failed': return { box: 'border-red-400/60 bg-red-500/15 text-red-200', text: 'text-red-200', icon: '×' };
    case 'blocked': return { box: 'border-amber-400/60 bg-amber-500/15 text-amber-200', text: 'text-amber-200', icon: '!' };
    case 'skipped': return { box: 'border-surface-650 bg-surface-850 text-surface-500', text: 'text-surface-500', icon: '−' };
    default: return { box: 'border-surface-650 bg-surface-900 text-surface-500', text: 'text-surface-500', icon: '' };
  }
}

export function ProcessMapPreview({ map, loading, onReload, playbackActive = false }: { map: ProcessMap | null; loading: boolean; onReload: () => void; playbackActive?: boolean }) {
  const nodes = useMemo(() => {
    if (!map) return [];
    if (!playbackActive) return map.nodes;
    const activeIndex = map.nodes.findIndex((node) => node.status === 'running');
    const currentIndex = activeIndex >= 0 ? activeIndex : map.nodes.findIndex((node) => node.status === 'pending');
    if (currentIndex < 0) return map.nodes;
    return map.nodes.map((node, index) => ({
      ...node,
      status: (index < currentIndex ? 'completed' : index === currentIndex ? 'running' : 'pending') as ProcessNodeStatus,
      summary: index === currentIndex ? node.summary || i18n.t('processRunningSummary', { ns: 'schedule' }) : node.summary,
    }));
  }, [map, playbackActive]);

  if (loading) {
    return <div className="text-[13px] text-surface-500">{i18n.t('processLoading', { ns: 'schedule' })}</div>;
  }
  if (!map) {
    return <div className="text-[13px] text-surface-500">{i18n.t('processEmpty', { ns: 'schedule' })}</div>;
  }

  const doneCount = nodes.filter((node) => node.status === 'completed').length;
  const hasProblem = nodes.some((node) => node.status === 'failed' || node.status === 'blocked');
  const currentNode = nodes.find((node) => node.status === 'running') || nodes.find((node) => node.status === 'pending') || nodes[nodes.length - 1];

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-surface-200">{map.title}</div>
          <div className="mt-0.5 text-[12px] text-surface-500">
            {hasProblem ? i18n.t('processNeedsAttention', { ns: 'schedule' }) : i18n.t('processCompleted', { ns: 'schedule', done: doneCount, total: nodes.length })}
            {currentNode ? ` · ${i18n.t('processCurrent', { ns: 'schedule', label: currentNode.label })}` : ''}
          </div>
        </div>
        <button type="button" onClick={onReload} className="shrink-0 rounded-md bg-surface-800 px-2 py-1 text-[12px] font-semibold text-surface-300 hover:bg-surface-700">{i18n.t('refresh', { ns: 'schedule' })}</button>
      </div>

      <div className="rounded-2xl border border-surface-800 bg-surface-950/35 p-3">
        {nodes.length === 0 ? (
          <div className="text-[13px] text-surface-500">{i18n.t('processNoSteps', { ns: 'schedule' })}</div>
        ) : (
          <ol className="space-y-2">
            {nodes.map((node) => {
              const status = node.status as ProcessNodeStatus;
              const tone = processStepTone(status);
              return (
                <li key={node.id} className="rounded-xl border border-surface-800 bg-surface-900/55 px-3 py-2.5">
                  <div className="flex items-start gap-3">
                    <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border text-[12px] font-black ${tone.box}`}>{tone.icon}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-[13px] font-semibold text-surface-100">{node.label}</span>
                        <span className={`text-[11px] font-bold ${tone.text}`}>{processStepStatusLabel(status)}</span>
                      </div>
                      {node.summary && <p className="mt-1 line-clamp-2 text-[12px] leading-4 text-surface-500">{node.summary}</p>}
                      {node.evidence?.logs?.length ? (
                        <p className="mt-1 line-clamp-1 text-[11px] text-surface-600">{node.evidence.logs[0]}</p>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}

export function duration(run: AutomationRun): string {
  if (run.durationMs == null) return '-';
  if (run.durationMs < 1000) return `${run.durationMs}ms`;
  return `${(run.durationMs / 1000).toFixed(1)}s`;
}

export function SchedulePanel() {
  const { t } = useTranslation('schedule');
  const confirm = useConfirm();
  const openSystemTab = useFileStore((s) => s.openSystemTab);
  const openChatTab = useFileStore((s) => s.openChatTab);
  const setActiveSessionId = useSessionStore((s) => s.setActiveSessionId);
  const setActiveView = useSessionStore((s) => s.setActiveView);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const addSession = useSessionStore((s) => s.addSession);
  const projects = useProjectStore((s) => s.projects);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const generalProject = useMemo(() => projects.find((p) => p.name.toLowerCase() === 'general' || p.rootPath?.endsWith('/general')), [projects]);

  const [jobs, setJobs] = useState<Automation[]>([]);
  const [runs, setRuns] = useState<Array<AutomationRun & { outcomeUnverified?: boolean }>>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [selectedResultRunId, setSelectedResultRunId] = useState<string | null>(null);
  const [results, setResults] = useState<AutomationResultItem[]>([]);
  const [resultsLoading, setResultsLoading] = useState(true);
  const [resultsError, setResultsError] = useState<string | null>(null);
  const resultsRequest = useRef(0);
  const [resultsRefresh, setResultsRefresh] = useState(0);
  const [processMap, setProcessMap] = useState<ProcessMap | null>(null);
  const [processMapRunId, setProcessMapRunId] = useState<string | null>(null);
  const [processMapLoading, setProcessMapLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('upcoming');
  const [listWidth, setListWidth] = useState(() => {
    const stored = Number(localStorage.getItem(SCHEDULE_LIST_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? Math.min(MAX_SCHEDULE_LIST_WIDTH, Math.max(MIN_SCHEDULE_LIST_WIDTH, stored)) : 560;
  });
  const [projectFilter, setProjectFilter] = useState('all');
  const [runningNowIds, setRunningNowIds] = useState<Set<string>>(() => new Set());
  const [creating, setCreating] = useState(false);
  const [createProjectId, setCreateProjectId] = useState<string | undefined>();
  const [createRequest, setCreateRequest] = useState('');
  const [createKey, setCreateKey] = useState(0);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchJson<Automation[]>(API);
      const scheduleJobs = data.filter((j) => j.status !== 'archived');
      setJobs(scheduleJobs);
      setSelectedId((current) => current && scheduleJobs.some((j) => j.id === current) ? current : null);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const request = ++resultsRequest.current;
    const controller = new AbortController();
    if (projectFilter === 'all' || projectFilter === 'system') {
      setResults([]);
      setResultsError(null);
      setResultsLoading(false);
      return () => { controller.abort(); resultsRequest.current++; };
    }
    const query = new URLSearchParams({ limit: '50', projectId: projectFilter });
    setResultsLoading(true);
    setResults([]);
    setResultsError(null);
    void fetchJson<{ items: AutomationResultItem[] }>(`${API}/results?${query}`, { signal: controller.signal })
      .then((data) => {
        if (request !== resultsRequest.current || controller.signal.aborted) return;
        if (!Array.isArray(data.items)) throw new Error(i18n.t('resultsInvalidResponse', { ns: 'schedule' }));
        setResults(data.items);
      })
      .catch((err: Error) => {
        if (request !== resultsRequest.current || controller.signal.aborted) return;
        setResultsError(err.message || 'Request failed');
      })
      .finally(() => {
        if (request === resultsRequest.current && !controller.signal.aborted) setResultsLoading(false);
      });
    return () => { controller.abort(); resultsRequest.current++; };
  }, [projectFilter, resultsRefresh]);

  const refreshResults = () => setResultsRefresh((value) => value + 1);

  // Keep unattended executions visible without polling hidden tabs.
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) { void load(); setResultsRefresh((value) => value + 1); } }, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const startListResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = listWidth;
    const handleMove = (moveEvent: PointerEvent) => {
      const next = Math.min(MAX_SCHEDULE_LIST_WIDTH, Math.max(MIN_SCHEDULE_LIST_WIDTH, startWidth + moveEvent.clientX - startX));
      setListWidth(next);
    };
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      const finalWidth = Math.min(MAX_SCHEDULE_LIST_WIDTH, Math.max(MIN_SCHEDULE_LIST_WIDTH, startWidth));
      localStorage.setItem(SCHEDULE_LIST_WIDTH_KEY, String(finalWidth));
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  }, [listWidth]);

  useEffect(() => {
    localStorage.setItem(SCHEDULE_LIST_WIDTH_KEY, String(Math.round(listWidth)));
  }, [listWidth]);

  const filteredJobs = useMemo(() => {
    let list = jobs;
    if (projectFilter === 'system') list = list.filter((j) => !j.projectId || j.scopeType === 'system');
    else if (projectFilter !== 'all') list = list.filter((j) => j.projectId === projectFilter);
    return list;
  }, [jobs, projectFilter]);

  const upcomingJobs = useMemo(() => filteredJobs.filter((job) => job.enabled && job.nextRunAt).sort((a, b) => {
    const aNext = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
    const bNext = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
    return aNext - bNext || a.name.localeCompare(b.name);
  }), [filteredJobs]);

  const registeredJobs = useMemo(() => [...filteredJobs].sort((a, b) => {
    const aUpdated = new Date(a.configUpdatedAt || a.createdAt).getTime();
    const bUpdated = new Date(b.configUpdatedAt || b.createdAt).getTime();
    return bUpdated - aUpdated || a.name.localeCompare(b.name);
  }), [filteredJobs]);

  const selectedJob = useMemo(
    () => jobs.find((j) => j.id === selectedId) ?? null,
    [jobs, selectedId],
  );


  const runsRequest = useRef<AbortController | null>(null);
  const processRequest = useRef<AbortController | null>(null);
  const loadRuns = useCallback(async (id: string) => {
    runsRequest.current?.abort();
    const controller = new AbortController();
    runsRequest.current = controller;
    setRunsLoading(true);
    setRuns([]);
    setRunsError(null);
    try {
      const data = await fetchJson<AutomationRun[]>(`${API}/${id}/runs?limit=5`, { signal: controller.signal });
      if (!controller.signal.aborted) setRuns(data);
    } catch (err: any) {
      if (!controller.signal.aborted) setRunsError(err.message);
    } finally {
      if (!controller.signal.aborted) setRunsLoading(false);
    }
  }, []);

  const loadProcessMap = useCallback(async (jobId: string, runId: string) => {
    processRequest.current?.abort();
    const controller = new AbortController();
    processRequest.current = controller;
    try {
      setProcessMapLoading(true);
      setProcessMapRunId(runId);
      const data = await fetchJson<ProcessMap>(`${API}/${jobId}/runs/${runId}/process-map`, { signal: controller.signal });
      if (!controller.signal.aborted) setProcessMap(data);
    } catch {
      if (!controller.signal.aborted) setProcessMap(null);
    } finally {
      if (!controller.signal.aborted) setProcessMapLoading(false);
    }
  }, []);

  useEffect(() => {
    processRequest.current?.abort();
    setProcessMapLoading(false);
    if (selectedJob) {
      setProcessMap(null);
      setProcessMapRunId(null);
      void loadRuns(selectedJob.id);
    }
    else {
      runsRequest.current?.abort();
      setRuns([]);
      setProcessMap(null);
      setProcessMapRunId(null);
    }
    return () => { runsRequest.current?.abort(); processRequest.current?.abort(); };
  }, [selectedJob?.id, loadRuns]);

  useEffect(() => {
    const latestRun = selectedResultRunId ? results.find((item) => item.automationId === selectedJob?.id && item.run.id === selectedResultRunId)?.run || runs.find((run) => run.id === selectedResultRunId) : runs[0];
    if (selectedJob && latestRun && processMapRunId !== latestRun.id) {
      void loadProcessMap(selectedJob.id, latestRun.id);
    } else if (!latestRun) {
      setProcessMap(null);
      setProcessMapRunId(null);
    }
  }, [selectedJob?.id, selectedResultRunId, runs, results, processMapRunId, loadProcessMap]);

  const openJobTab = (job: Automation) => {
    setSelectedId(job.id);
    openSystemTab('schedule', { refId: job.id, title: job.name, icon: '⏰' });
    setActiveView('chat');
  };

  const openAutomationAiThread = async (job: Automation) => {
    setSelectedId(job.id);
    if (isCreationDraft(job)) {
      setCreateProjectId(job.projectId || undefined);
      setCreateRequest(job.prompt);
      setCreateKey(k => k + 1);
      setCreating(true);
      return;
    }
    try {
      const r = await fetchJson<{ session: any; created: boolean }>(`${API}/${job.id}/editor-thread`, {
        method: 'POST',
        body: JSON.stringify({ parentSessionId: activeSessionId || undefined }),
      });
      addSession({
        ...r.session,
        updatedAt: r.session.updatedAt || new Date().toISOString(),
        turnCount: Math.max(1, r.session.turnCount || 0),
      });
      const store = useAiPanelStore.getState();
      const panelContextId = r.session.parentSessionId || activeSessionId || r.session.id;
      store.setContext('session', panelContextId, {
        path: `automation:${job.id}`,
        title: job.name,
        language: 'automation',
      });
      store.addThread({ ...r.session, aiPanelScope: 'session' });
      store.setActiveThreadId(r.session.id);
      store.setMessages([]);
      store.setPendingQuestion(null);
      store.setOpen(true);
    } catch (err: any) {
      setError(err.message || t('aiThreadOpenFailed'));
    }
  };

  const selectResult = (item: AutomationResultItem) => {
    setSelectedResultRunId(item.run.id);
    setSelectedId(item.automationId);
  };

  const openResultSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    openChatTab(sessionId);
    setActiveView('chat');
  };

  const resultProps = { items: results, loading: resultsLoading, error: resultsError, projectRequired: projectFilter === 'all' || projectFilter === 'system', onRetry: refreshResults, projectById, onSelect: selectResult, onOpenSession: openResultSession };

  const selectJob = (job: Automation) => {
    setSelectedResultRunId(null);
    setSelectedId(job.id);
  };

  const handleToggle = async (job: Automation) => {
    if (isCreationDraft(job)) return;
    const enabled = !job.enabled;
    const ok = await confirm({ title: enabled ? t('enableConfirmTitle', { ns: 'automation' }) : t('pauseConfirmTitle', { ns: 'automation' }), message: enabled ? t('enableConfirmMessage', { ns: 'automation' }) : t('pauseConfirmMessage', { ns: 'automation' }), confirmLabel: enabled ? t('enableAction', { ns: 'automation' }) : t('pauseAction', { ns: 'automation' }) });
    if (!ok) return;
    try {
      await fetchJson(`${API}/${job.id}/enabled`, { method: 'POST', body: JSON.stringify({ enabled, confirmed: true }) });
      await load();
    } catch (err: any) { setError(err.message); }
  };

  const handleRunNow = async (job: Automation) => {
    if (isCreationDraft(job) || runningNowIds.has(job.id)) return;
    const ok = await confirm({ title: t('runNowConfirmTitle'), message: t('runNowConfirmMessage', { name: job.name }), confirmLabel: t('runNow') });
    if (!ok) return;
    if (selectedJob?.id !== job.id) setSelectedId(job.id);
    setRunningNowIds((ids) => new Set(ids).add(job.id));
    try {
      setError(null);
      await fetchJson(`${API}/${job.id}/run-now`, { method: 'POST' });
      await load();
      await loadRuns(job.id);
      refreshResults();
    } catch (err: any) { setError(err.message); }
    finally {
      setRunningNowIds((ids) => {
        const next = new Set(ids);
        next.delete(job.id);
        return next;
      });
    }
  };

  const handleDelete = async (job: Automation) => {
    const ok = await confirm({ title: t('delete'), message: t('confirmDelete'), confirmLabel: t('delete'), danger: true });
    if (!ok) return;
    try {
      await fetchJson(`${API}/${job.id}`, { method: 'DELETE' });
      setSelectedId(null);
      await load();
    } catch (err: any) { setError(err.message); }
  };

  const openCreate = () => {
    const defaultProjectId = projectFilter !== 'all' && projectFilter !== 'system'
      ? projectFilter
      : (generalProject?.id || projects[0]?.id);
    setCreateProjectId(defaultProjectId);
    setCreateRequest('');
    setCreateKey(k => k + 1);
    setCreating(true);
  };

  const currentList = view === 'upcoming' ? upcomingJobs : registeredJobs;
  const selectedProject = selectedJob?.projectId ? projectById.get(selectedJob.projectId) : null;
  const selectedRelatedFiles = selectedJob ? extractRelatedFiles(selectedJob, selectedProject?.rootPath) : [];
  const selectedDefinition = selectedJob?.definitionJson || {};
  const selectedCommand = typeof selectedDefinition.command === 'string' ? selectedDefinition.command : (typeof selectedDefinition.script === 'string' ? selectedDefinition.script : '');
  const groupedUpcoming = currentList.reduce<Array<{ label: string; jobs: Automation[] }>>((groups, job) => {
    const label = view === 'upcoming' ? dayLabel(job.nextRunAt, t) : t('recentlyConfigured');
    const found = groups.find((g) => g.label === label);
    if (found) found.jobs.push(job); else groups.push({ label, jobs: [job] });
    return groups;
  }, []);

  const renderJobRow = (job: Automation) => {
    const badge = statusBadge(job, t);
    const project = job.projectId ? projectById.get(job.projectId) : null;
    const projectName = project?.name || (job.scopeType === 'system' ? t('systemJobs') : t('noProject'));
    const configUpdatedAt = job.configUpdatedAt || job.createdAt;
    const time = view === 'upcoming'
      ? timeLabel(job.nextRunAt, t)
      : { main: new Date(configUpdatedAt).toLocaleDateString(), sub: `${relativeTime(configUpdatedAt)}` };
    const description = (job.description || job.prompt || '').trim();
    return (
      <article
        key={job.id}
        className={`w-full rounded-2xl border transition ${selectedJob?.id === job.id ? 'bg-primary-500/10 border-primary-500/35 shadow-sm shadow-primary-950/30' : 'bg-surface-850/55 border-surface-800 hover:bg-surface-800/80 hover:border-surface-700'}`}
      >
        <div className="grid grid-cols-[88px_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5">
          <button onClick={() => selectJob(job)} className="text-left">
            <div className="text-[13px] font-bold text-gray-100 leading-4">{time.main}</div>
            <div className="mt-0.5 text-[11px] font-medium text-surface-500">{time.sub}</div>
          </button>
          <button onClick={() => selectJob(job)} className="min-w-0 text-left">
            <div className="truncate text-[14px] font-semibold text-gray-100">{job.name}</div>
            <div className="mt-1 flex min-w-0 items-center gap-2 text-[12px] text-surface-500">
              <span className="min-w-0 truncate rounded-md border border-surface-700 bg-surface-900/70 px-1.5 py-0.5 text-surface-300">{projectName}</span>
              <span className="shrink-0">{triggerLabel(job, t)}</span>
            </div>
            {description && <div className="mt-1 line-clamp-1 text-[12px] leading-4 text-surface-500">{description}</div>}
            {view === 'registered' && job.creatorName && <div className="mt-1 truncate text-[12px] text-surface-600">{job.creatorName}</div>}
          </button>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className={`tone-pill text-[12px] px-1.5 py-0.5 rounded ${badge.cls}`}>{badge.text}</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); void handleToggle(job); }}
              className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${job.enabled ? 'bg-primary-500' : 'bg-surface-650'}`}
              aria-label={job.enabled ? t('disable') : t('enable')}
              disabled={isCreationDraft(job)}
              aria-pressed={job.enabled}
            >
              <span className={`inline-block h-3 w-3 rounded-full bg-white transition ${job.enabled ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
            </button>
            <button disabled={isCreationDraft(job) || runningNowIds.has(job.id)} onClick={() => handleRunNow(job)} className="min-h-[32px] rounded-lg bg-surface-800 px-2 py-1.5 text-[12px] font-semibold text-surface-200 hover:bg-primary-500 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed">
              {runningNowIds.has(job.id) ? t('running') : t('runNow')}
            </button>
            <button onClick={() => void openAutomationAiThread(job)} className="min-h-[32px] rounded-lg border border-teal-300 bg-teal-50 px-2 py-1.5 text-[12px] font-semibold text-teal-800 hover:bg-teal-100 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-100 dark:hover:bg-primary-500/20">
              {t('adjust')}
            </button>
          </div>
        </div>
      </article>
    );
  };

  return (
    <div data-testid="automation-panel" className="flex flex-col h-full bg-surface-950">
      <div className="flex items-center justify-between px-5 py-4 border-b border-surface-800">
        <div className="flex items-center gap-2">
          <span className="text-xl">⏰</span>
          <div>
            <h1 className="text-base font-bold text-gray-100">{t('title')}</h1>
            <p className="text-[13px] text-surface-500">{t('subtitle')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => selectedJob && openJobTab(selectedJob)}
            disabled={!selectedJob}
            className="rounded-full border border-surface-700 bg-surface-850 px-2.5 py-1 text-[12px] font-bold text-surface-400 transition hover:text-surface-100 disabled:cursor-not-allowed disabled:opacity-45"
            title={t('advancedCheckTitle')}
          >
            {t('advancedCheck')} ↗
          </button>
          <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} className="bg-surface-850 border border-surface-700 rounded-lg px-2 py-1.5 text-[13px] text-surface-200">
            <option value="all">{t('allProjects')}</option>
            <option value="system">{t('systemJobs')}</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button onClick={openCreate} className="px-3.5 py-2 rounded-lg bg-primary-500 text-white text-[13px] font-semibold hover:bg-primary-400" title={t('createHint')}>
            + {t('create')}
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-2 px-3 py-1.5 text-[12px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg">
          {error}<button onClick={() => setError(null)} className="ml-2 underline">{t('dismiss')}</button>
        </div>
      )}

      {creating && <AutomationCreatePanel
        key={createKey}
        initialRequest={createRequest}
        projects={projects}
        initialProjectId={createProjectId}
        sourceSessionId={activeSessionId}
        onCancel={() => setCreating(false)}
        onCreated={(automation) => {
          setCreating(false);
          setSelectedId(automation.id);
          setView('registered');
          void load();
        }}
      />}

      <div className="relative grid flex-1 min-h-0 grid-cols-1 gap-0 lg:grid-cols-[minmax(420px,var(--schedule-list-width))_minmax(0,1fr)]" style={{ '--schedule-list-width': `${listWidth}px` } as CSSProperties}>
        <section className="min-h-0 flex flex-col border-r border-surface-800 max-lg:border-r-0">
          <div className="px-5 pt-4">
            <div className="inline-flex p-0.5 rounded-lg bg-surface-850 border border-surface-750">
              <button onClick={() => setView('upcoming')} className={`px-3 py-1.5 rounded-md text-[13px] font-semibold ${view === 'upcoming' ? 'bg-surface-700 text-white' : 'text-surface-500 hover:text-surface-200'}`}>
                {t('upcomingExecutions')}
              </button>
              <button onClick={() => setView('registered')} className={`px-3 py-1.5 rounded-md text-[13px] font-semibold ${view === 'registered' ? 'bg-surface-700 text-white' : 'text-surface-500 hover:text-surface-200'}`}>
                {t('recentlyRegistered')}
              </button>
              <button onClick={() => setView('results')} className={`px-3 py-1.5 rounded-md text-[13px] font-semibold ${view === 'results' ? 'bg-surface-700 text-white' : 'text-surface-500 hover:text-surface-200'}`}>{t('resultsTitle')}</button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            {view === 'results' ? <AutomationResultsPanel {...resultProps} /> : loading ? (
              <div className="text-center text-surface-500 text-sm py-8">{t('loading')}</div>
            ) : currentList.length === 0 ? (
              <div className="text-center py-12 max-w-sm mx-auto">
                <div className="text-4xl mb-3">⏰</div>
                <p className="text-base text-surface-300">{t('empty')}</p>
                <p className="text-[13px] text-surface-500 mt-2 leading-5">{t('emptyHint')}</p>
              </div>
            ) : groupedUpcoming.map((group) => (
              <div key={group.label}>
                <div className="flex items-center gap-2 mb-2">
                  <div className="text-[12px] uppercase tracking-wider text-surface-500 font-bold">{group.label}</div>
                  <div className="h-px flex-1 bg-surface-800" />
                </div>
                <div className="space-y-2">{group.jobs.map(renderJobRow)}</div>
              </div>
            ))}
          </div>
        </section>

        <button
          type="button"
          aria-label={t('resizeList')}
          title={t('resizeListHelp')}
          onPointerDown={startListResize}
          className="absolute bottom-0 top-0 z-10 -ml-1 hidden w-3 cursor-col-resize border-l border-primary-500/30 bg-primary-500/5 transition hover:border-primary-400 hover:bg-primary-400/10 lg:block"
          style={{ left: listWidth }}
        >
          <span className="absolute left-1/2 top-1/2 h-10 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-500/45" />
        </button>

        <aside className="min-h-0 overflow-y-auto p-4 bg-surface-925/60">
          {!selectedJob && view === 'results' ? (
            <div className="rounded-xl border border-surface-800 bg-surface-900/50 p-4 text-[13px] text-surface-400">{t('resultSelectForDetails')}</div>
          ) : !selectedJob ? (
            <ScheduleOverview
              jobs={filteredJobs}
              allJobs={jobs}
              upcomingJobs={upcomingJobs}
              registeredJobs={registeredJobs}
              projectById={projectById}
              selectedProjectFilter={projectFilter}
              onProjectFilterChange={setProjectFilter}
              onSelect={selectJob}
              onOpenAiThread={openAutomationAiThread}
              onCreate={openCreate}
              latestResult={resultProps}
              t={t}
            />
          ) : (
            <div className="space-y-3">
              <div className="rounded-xl border border-surface-800 bg-surface-900/50 px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-bold text-gray-100 leading-5">{selectedJob.name}</h2>
                    <p className="mt-1 text-[13px] text-surface-500 leading-4">
                      {triggerLabel(selectedJob, t)} · {jobTypeLabel(selectedJob.jobType, t)} · {selectedJob.projectId ? projectById.get(selectedJob.projectId)?.name : t('systemJobs')}
                    </p>
                  </div>
                  <div className="shrink-0 flex items-center gap-2">
                    <span className={`tone-pill text-[12px] px-1.5 py-0.5 rounded ${statusBadge(selectedJob, t).cls}`}>{statusBadge(selectedJob, t).text}</span>
                    <button disabled={isCreationDraft(selectedJob)} onClick={() => handleToggle(selectedJob)} className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${selectedJob.enabled ? 'bg-primary-500' : 'bg-surface-650'}`} aria-pressed={selectedJob.enabled} aria-label={selectedJob.enabled ? t('disable') : t('enable')}>
                      <span className={`inline-block h-4 w-4 rounded-full bg-white transition ${selectedJob.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </button>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <button disabled={isCreationDraft(selectedJob) || runningNowIds.has(selectedJob.id)} onClick={() => handleRunNow(selectedJob)} className="min-h-[40px] px-2 py-2 text-[14px] font-semibold rounded-lg bg-primary-500 text-white hover:bg-primary-400 disabled:opacity-50 disabled:cursor-not-allowed">{runningNowIds.has(selectedJob.id) ? t('running') : `▶ ${t('runNow')}`}</button>
                <button onClick={() => void openAutomationAiThread(selectedJob)} className="min-h-[40px] px-2 py-2 text-[14px] font-semibold rounded-lg bg-surface-800 text-surface-200 hover:bg-surface-750">{t(isCreationDraft(selectedJob) ? 'planDraftResume' : 'reviewChanges')}</button>
                <button onClick={() => handleDelete(selectedJob)} className="min-h-[40px] px-2 py-2 text-[14px] font-semibold rounded-lg bg-red-500/10 text-red-300 hover:bg-red-500/20">{t('delete')}</button>
              </div>

              <div className="grid grid-cols-2 gap-3 max-xl:grid-cols-1">
                <div className="border border-surface-800 rounded-xl p-3 bg-surface-900/50">
                  <div className="text-[12px] uppercase tracking-wider font-bold text-surface-500 mb-2">{t('description')}</div>
                  <p className="text-[13px] leading-4 text-surface-300 whitespace-pre-wrap line-clamp-4">
                    {(selectedJob.description || selectedJob.prompt || t('noDescription'))}
                  </p>
                </div>
                <div className="border border-surface-800 rounded-xl p-3 bg-surface-900/50">
                  <div className="text-[12px] uppercase tracking-wider font-bold text-surface-500 mb-2">{t('details')}</div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[13px]">
                    <dt className="text-surface-500">{t('nextRun')}</dt><dd className="text-surface-200 text-right truncate">{selectedJob.nextRunAt ? new Date(selectedJob.nextRunAt).toLocaleString() : '-'}</dd>
                    <dt className="text-surface-500">{t('schedule')}</dt><dd className="text-surface-200 text-right truncate">{triggerLabel(selectedJob, t)}</dd>
                    <dt className="text-surface-500">{t('runs')}</dt><dd className="text-surface-200 text-right">{selectedJob.runCount}</dd>
                    <dt className="text-surface-500">{t('risk')}</dt><dd className="text-surface-200 text-right">{selectedJob.riskLevel}</dd>
                  </dl>
                </div>
              </div>

              <div className="border border-surface-800 rounded-xl p-3 bg-surface-900/50">
                <div className="text-[12px] uppercase tracking-wider font-bold text-surface-500 mb-2">{t('origin')}</div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[13px]">
                  <dt className="text-surface-500">{t('project')}</dt><dd className="text-surface-200 text-right truncate">{selectedJob.projectId ? projectById.get(selectedJob.projectId)?.name : t('systemJobs')}</dd>
                  <dt className="text-surface-500">{t('creator')}</dt><dd className="text-surface-200 text-right truncate">{selectedJob.creatorName || `user ${selectedJob.userId}`}</dd>
                  <dt className="text-surface-500">{t('created')}</dt><dd className="text-surface-200 text-right truncate">{new Date(selectedJob.createdAt).toLocaleString()}</dd>
                  <dt className="text-surface-500">{t('configChanged')}</dt><dd className="text-surface-200 text-right truncate">{new Date(selectedJob.configUpdatedAt || selectedJob.updatedAt).toLocaleString()}</dd>
                  <dt className="text-surface-500">{t('lastExecuted')}</dt><dd className="text-surface-200 text-right truncate">{selectedJob.lastRunAt ? new Date(selectedJob.lastRunAt).toLocaleString() : '-'}</dd>
                  {selectedJob.createdBySessionId && <><dt className="text-surface-500">{t('sourceSession')}</dt><dd className="text-surface-200 text-right truncate">{selectedJob.createdBySessionId.slice(0, 8)}</dd></>}
                </dl>
              </div>

              {(selectedCommand || selectedRelatedFiles.length > 0) && (
                <div className="border border-surface-800 rounded-xl p-3 bg-surface-900/50">
                  <div className="text-[12px] uppercase tracking-wider font-bold text-surface-500 mb-2">{t('relatedFiles')}</div>
                  {selectedCommand && <code className="block mb-2 rounded-lg bg-black/25 px-2 py-1.5 text-[12px] leading-4 text-surface-300 line-clamp-3">{selectedCommand}</code>}
                  {selectedRelatedFiles.length > 0 && <div className="flex flex-wrap gap-1.5">
                    {selectedRelatedFiles.map((file) => <button key={file} onClick={() => openTowerFile(file)} title={file} className="max-w-full truncate rounded-md border border-surface-700 bg-surface-850 px-2 py-1 text-[12px] text-primary-300 hover:border-primary-500/60">{file.split('/').pop() || file}</button>)}
                  </div>}
                </div>
              )}

              <div className="border border-surface-800 rounded-xl p-3 bg-surface-900/50">
                <div className="text-[12px] uppercase tracking-wider font-bold text-surface-500 mb-2">{t('runLog')}</div>
                {results.filter((item) => item.automationId === selectedJob.id && (!selectedResultRunId || item.run.id === selectedResultRunId)).slice(0, 1).map((item) => <div key={item.run.id} className="mb-3 border-b border-surface-800 pb-2 text-[13px]"><span className="font-semibold text-surface-200">{resultStatusLabel(resultStatus(item), t)}</span> · {new Date(item.run.ranAt).toLocaleString()}<p className="mt-1 whitespace-pre-wrap break-words text-surface-300">{item.run.summaryText || item.run.error || t('resultNoSummary')}</p>{item.sessionId ? <button type="button" onClick={() => openResultSession(item.sessionId!)} className="mt-1 text-primary-300 hover:underline">{t('resultOpenSession')}</button> : <span className="mt-1 block text-surface-500">{t('resultNoSession')}</span>}</div>)}
                {runsLoading ? <div role="status" className="text-[13px] text-surface-400">{t('resultsLoading')}</div> : runsError ? <div role="alert" className="text-[13px] text-red-300">{t('resultsLoadFailed')}: {runsError} <button type="button" onClick={() => void loadRuns(selectedJob.id)} className="underline">{t('resultsRetry')}</button></div> : runs.length === 0 ? <div className="text-[13px] text-surface-500">{t('noRuns')}</div> : (
                  <div className="space-y-2">
                    {runs.map((run) => (
                      <div key={run.id} className="text-[13px] border-b border-surface-800 last:border-b-0 pb-2 last:pb-0">
                        <div className="flex items-center justify-between gap-2">
                          <button type="button" onClick={() => { setSelectedResultRunId(run.id); if (selectedJob) void loadProcessMap(selectedJob.id, run.id); }} className={`${run.status === 'success' && !run.outcomeUnverified ? 'tone-success tone-text' : ['failed', 'timeout'].includes(run.status) ? 'tone-danger tone-text' : 'text-surface-300'} hover:underline`}>{resultStatusLabel(resultStatus({ automationId: selectedJob.id, automationName: selectedJob.name, projectId: selectedJob.projectId, run, outcomeUnverified: run.outcomeUnverified }), t)}</button>
                          <span className="text-surface-500">{new Date(run.ranAt).toLocaleString()} · {duration(run)}</span>
                        </div>
                        {run.summaryText && <p className="mt-1 whitespace-pre-wrap break-words text-surface-300">{run.summaryText}</p>}
                        {run.error && <div className="mt-1 text-red-300">{run.error}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="border border-surface-800 rounded-xl p-3 bg-surface-900/50">
                <div className="text-[12px] uppercase tracking-wider font-bold text-surface-500 mb-2">{t('progressStatus')}</div>
                <ProcessMapPreview
                  map={processMap}
                  loading={processMapLoading}
                  onReload={() => { if (selectedJob && processMapRunId) void loadProcessMap(selectedJob.id, processMapRunId); }}
                  playbackActive={selectedJob ? runningNowIds.has(selectedJob.id) : false}
                />
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
