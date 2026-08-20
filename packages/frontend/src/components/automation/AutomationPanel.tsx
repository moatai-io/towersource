/**
 * AutomationPanel v3 — Ultra-minimal, Linear/Notion-inspired.
 *
 * Structure:
 *   1. Template chips (horizontal scroll) → click → inline prompt → run
 *   2. Running items (pulse dot, only when active)
 *   3. Flat list (dot + name + schedule ... ▶ toggle)
 *   4. Click row → expand detail (progressive disclosure)
 *
 * Replaces both KanbanBoard and SchedulePanel.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useModelStore } from '../../stores/model-store';
import type { Automation, AutomationRun, WorkflowTemplate } from '@tower/shared';
import { useConfirm } from '../../hooks/useDialog';
import { toastError } from '../../utils/toast';
import { RunIndicator } from '../common/RunIndicator';
import { AutomationWorkbenchModal } from '../../features/automation-workbench/AutomationWorkbenchModal';

const API = '/api/automations';

// ── Fetch helper ──

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

// ── Helpers ──

function triggerLabel(a: Automation, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (a.triggerType === 'manual') return '';
  if (a.triggerType === 'once' && a.onceAt) return new Date(a.onceAt).toLocaleDateString();
  if (!a.cronConfig) return '';
  const c = a.cronConfig;
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(c.hour ?? 9)}:${pad(c.minute ?? 0)}`;
  switch (c.type) {
    case 'daily': return t('triggerDaily', { time });
    case 'weekdays': return t('triggerWeekdays', { time });
    case 'weekly': return t('triggerWeekly', { day: t(`day${c.day ?? 1}`), time });
    case 'interval': return t('triggerInterval', { value: c.hours ?? 1, unit: t('hoursUnit') });
    default: return '';
  }
}

function elapsedStr(since: string): string {
  const ms = Date.now() - new Date(since).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ── Component ──

export function AutomationPanel() {
  const { t } = useTranslation('automation');
  const confirm = useConfirm();
  const projects = useProjectStore((s) => s.projects);
  const activeProjects = useMemo(() => projects.filter(p => !p.archived), [projects]);

  const [automations, setAutomations] = useState<Automation[]>([]);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterProjectId, setFilterProjectId] = useState<string | null>(null);

  // Inline create from template
  const [inlineTemplate, setInlineTemplate] = useState<WorkflowTemplate | null>(null);
  const [inlinePrompt, setInlinePrompt] = useState('');
  const inlineInputRef = useRef<HTMLInputElement>(null);

  // Expand detail
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<AutomationRun[]>([]);

  // Create/Edit modal
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [workbenchAutomation, setWorkbenchAutomation] = useState<Automation | null>(null);

  // Elapsed time ticker (for running items)
  const [, setTick] = useState(0);
  const running = useMemo(() => automations.filter(a => a.status === 'running'), [automations]);
  useEffect(() => {
    if (running.length === 0) return;
    const iv = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(iv);
  }, [running.length]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [autoData, tplData] = await Promise.all([
        fetchJson<Automation[]>(API),
        fetchJson<WorkflowTemplate[]>(`${API}/templates`),
      ]);
      setAutomations(autoData);
      setTemplates(tplData);
    } catch (err) {
      console.error('Failed to load automations:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // WS updates for running tasks
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'task_update' || msg.type === 'task_progress' || msg.type === 'task_done') {
          load();
        }
      } catch {}
    };
    const ws = (window as any).__towerWs;
    if (ws) ws.addEventListener('message', handler);
    return () => { if (ws) ws.removeEventListener('message', handler); };
  }, [load]);

  // ── Filtered & sorted ──

  const filtered = useMemo(() => {
    let list = automations;
    if (filterProjectId) list = list.filter(a => a.projectId === filterProjectId);
    // Don't show archived
    list = list.filter(a => a.status !== 'archived');
    return list;
  }, [automations, filterProjectId]);

  const runningItems = useMemo(() => filtered.filter(a => a.status === 'running'), [filtered]);
  const listItems = useMemo(() => {
    // Non-running items, sorted: scheduled first, then idle, then done/failed
    const items = filtered.filter(a => a.status !== 'running');
    return items.sort((a, b) => {
      const order = (x: Automation) => {
        if (x.triggerType !== 'manual' && x.enabled) return 0; // scheduled
        if (x.status === 'idle') return 1;
        if (x.status === 'done') return 2;
        if (x.status === 'failed') return 3;
        return 4;
      };
      return order(a) - order(b) || a.sortOrder - b.sortOrder;
    });
  }, [filtered]);

  // ── Actions ──

  const handleRun = (automationId: string) => {
    const ws = (window as any).__towerWs;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'task_spawn', taskId: automationId }));
    } else {
      console.warn('[automation] WS not open');
    }
  };

  const handleAbort = (automationId: string) => {
    const ws = (window as any).__towerWs;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'task_abort', taskId: automationId }));
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    const nextEnabled = !enabled;
    const ok = await confirm({ title: nextEnabled ? t('enableConfirmTitle') : t('pauseConfirmTitle'), message: nextEnabled ? t('enableConfirmMessage') : t('pauseConfirmMessage'), confirmLabel: nextEnabled ? t('enableAction') : t('pauseAction') });
    if (!ok) return;
    try {
      await fetchJson(`${API}/${id}/enabled`, { method: 'POST', body: JSON.stringify({ enabled: nextEnabled, confirmed: true }) });
      setAutomations(prev => prev.map(a => a.id === id ? { ...a, enabled: nextEnabled } : a));
    } catch (err) {
      console.error('Failed to toggle:', err);
    }
  };

  const handleDelete = async (id: string) => {
    const ok = await confirm({
      title: t('delete', { defaultValue: 'Delete' }),
      message: t('confirmDelete'),
      confirmLabel: t('delete', { defaultValue: 'Delete' }),
      danger: true,
    });
    if (!ok) return;
    try {
      await fetchJson(`${API}/${id}`, { method: 'DELETE' });
      setAutomations(prev => prev.filter(a => a.id !== id));
      if (expandedId === id) setExpandedId(null);
    } catch (err) {
      console.error('Failed to delete:', err);
    }
  };

  const handleExpand = async (id: string) => {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
    try {
      const data = await fetchJson<AutomationRun[]>(`${API}/${id}/runs?limit=5`);
      setRuns(data);
    } catch { setRuns([]); }
  };

  const handleInlineRun = async () => {
    if (!inlineTemplate || !inlinePrompt.trim()) return;
    try {
      const created = await fetchJson<Automation>(`${API}/from-template`, {
        method: 'POST',
        body: JSON.stringify({
          templateId: inlineTemplate.id,
          prompt: inlinePrompt.trim(),
          projectId: filterProjectId,
        }),
      });
      setInlineTemplate(null);
      setInlinePrompt('');
      await load();
      // Auto-run the created automation
      handleRun(created.id);
    } catch (err) {
      console.error('Failed to create from template:', err);
    }
  };

  const handleCardClick = (a: Automation) => {
    if (a.sessionId) {
      const { setActiveView } = useSessionStore.getState();
      setActiveView('chat');
      window.dispatchEvent(new CustomEvent('kanban-select-session', { detail: { sessionId: a.sessionId } }));
    } else {
      handleExpand(a.id);
    }
  };

  // Focus inline input when template is selected
  useEffect(() => {
    if (inlineTemplate && inlineInputRef.current) {
      inlineInputRef.current.focus();
    }
  }, [inlineTemplate]);

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden px-3 py-3 sm:p-4">
      {/* ── Header ── */}
      <div className="mb-3 flex flex-shrink-0 flex-col gap-3 sm:mb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <h2 className="text-xl font-semibold text-gray-200">{t('title')}</h2>
          <select
            value={filterProjectId ?? ''}
            onChange={(e) => setFilterProjectId(e.target.value || null)}
            className="min-w-0 flex-1 cursor-pointer rounded-md border border-surface-700 bg-surface-800 px-2 py-1.5 text-sm text-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-500 sm:max-w-[180px] sm:flex-none"
          >
            <option value="">{t('allProjects')}</option>
            {activeProjects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {filterProjectId && (
            <button
              onClick={() => setFilterProjectId(null)}
              className="text-gray-500 hover:text-gray-300 transition-colors p-1"
              title={t('clearFilter')}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
        <button
          onClick={() => { setEditingId(null); setShowCreate(true); }}
          className="w-full rounded-lg bg-blue-600 px-3 py-2 text-base text-white transition-colors hover:bg-blue-500 sm:w-auto sm:py-1.5"
        >
          + {t('newAutomation')}
        </button>
      </div>

      {/* ── Template Chips ── */}
      {templates.length > 0 && (
        <div className="flex gap-2 mb-3 overflow-x-auto flex-shrink-0 pb-1 scrollbar-none">
          {templates.map(tpl => (
            <button
              key={tpl.id}
              onClick={() => {
                if (inlineTemplate?.id === tpl.id) {
                  setInlineTemplate(null);
                } else {
                  setInlineTemplate(tpl);
                  setInlinePrompt('');
                }
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm whitespace-nowrap transition-all flex-shrink-0 ${
                inlineTemplate?.id === tpl.id
                  ? 'border-blue-500/50 bg-blue-500/10 text-blue-400'
                  : 'border-surface-700 bg-surface-800 text-gray-400 hover:bg-surface-700 hover:text-gray-300'
              }`}
            >
              <span className="text-base">{tpl.icon}</span>
              {tpl.nameKo}
            </button>
          ))}
        </div>
      )}

      {/* ── Inline Create Bar ── */}
      {inlineTemplate && (
        <div className="mb-3 grid flex-shrink-0 grid-cols-[auto_1fr_auto] items-center gap-2 rounded-lg border border-surface-700 bg-surface-850 px-3 py-2.5 sm:flex">
          <span className="text-base flex-shrink-0">{inlineTemplate.icon}</span>
          <span className="hidden text-sm text-gray-400 flex-shrink-0 sm:inline">{inlineTemplate.nameKo}</span>
          <input
            ref={inlineInputRef}
            className="col-span-2 min-w-0 rounded-md border border-surface-700 bg-surface-800 px-2.5 py-1.5 text-base text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 sm:col-span-1 sm:flex-1"
            placeholder={inlineTemplate.description}
            value={inlinePrompt}
            onChange={(e) => setInlinePrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleInlineRun();
              if (e.key === 'Escape') { setInlineTemplate(null); setInlinePrompt(''); }
            }}
          />
          <button
            onClick={handleInlineRun}
            disabled={!inlinePrompt.trim()}
            className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors disabled:opacity-40 flex-shrink-0"
          >
            {t('runNow')}
          </button>
          <button
            onClick={() => { setInlineTemplate(null); setInlinePrompt(''); }}
            className="text-gray-500 hover:text-gray-300 p-1 flex-shrink-0"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* ── Content ── */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="flex items-center justify-center h-40 text-gray-500 text-base">{t('loading')}</div>
        ) : automations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-gray-500 text-base gap-2">
            <span className="text-3xl opacity-30">⚡</span>
            <p>{t('empty')}</p>
            <p className="text-sm text-gray-600">{t('emptyHint')}</p>
          </div>
        ) : (
          <>
            {/* ── Running ── */}
            {runningItems.length > 0 && (
              <div className="mb-3">
                {runningItems.map(a => (
                  <div
                    key={a.id}
                    className="mb-1.5 grid cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-x-2.5 gap-y-1 rounded-lg border border-surface-700 bg-surface-850 px-3 py-2.5 transition-colors hover:bg-surface-800 sm:flex"
                    onClick={() => handleCardClick(a)}
                  >
                    {/* Running signal */}
                    <RunIndicator size="xs" label={t('automationRunning')} className="flex-shrink-0 text-blue-400" />
                    {/* Name */}
                    <span className="text-base text-gray-200 flex-1 truncate">{a.name}</span>
                    {/* Creator badge */}
                    {a.creatorName && (
                      <span className="hidden text-[11px] px-1.5 py-0.5 rounded bg-surface-700/60 text-gray-500 font-medium flex-shrink-0 sm:inline">
                        @{a.creatorName}
                      </span>
                    )}
                    {/* Progress hint */}
                    {a.progressSummary?.length > 0 && (
                      <span className="col-start-2 row-start-2 max-w-full truncate text-[12px] text-gray-500 sm:max-w-[150px] sm:flex-shrink-0">
                        {a.progressSummary[a.progressSummary.length - 1]}
                      </span>
                    )}
                    {/* Elapsed */}
                    <span className="text-[13px] text-gray-500 flex-shrink-0 tabular-nums">
                      {elapsedStr(a.updatedAt)}
                    </span>
                    {/* Abort */}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleAbort(a.id); }}
                      className="text-[13px] px-2 py-0.5 rounded border border-red-500/20 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors flex-shrink-0"
                    >
                      Stop
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* ── Flat List ── */}
            <div>
              {listItems.map(a => (
                <AutomationRow
                  key={a.id}
                  automation={a}
                  expanded={expandedId === a.id}
                  runs={expandedId === a.id ? runs : []}
                  onCardClick={() => handleCardClick(a)}
                  onExpand={() => handleExpand(a.id)}
                  onRun={() => handleRun(a.id)}
                  onToggle={() => handleToggle(a.id, a.enabled)}
                  onEdit={() => setWorkbenchAutomation(a)}
                  onWorkbench={() => setWorkbenchAutomation(a)}
                  onDelete={() => handleDelete(a.id)}
                  t={t}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* ── Create/Edit Modal ── */}
      {showCreate && (
        <AutomationFormModal
          editingId={editingId}
          onClose={() => { setShowCreate(false); setEditingId(null); }}
          onSaved={() => { setShowCreate(false); setEditingId(null); load(); }}
          t={t}
        />
      )}

      {workbenchAutomation && (
        <AutomationWorkbenchModal
          automation={workbenchAutomation}
          onClose={() => setWorkbenchAutomation(null)}
          onOpenLegacyEdit={() => toastError(t('workbenchEditRequired'))}
        />
      )}
    </div>
  );
}


// ── Automation Row ──

function AutomationRow({ automation: a, expanded, runs, onCardClick, onExpand, onRun, onToggle, onEdit, onWorkbench, onDelete, t }: {
  automation: Automation;
  expanded: boolean;
  runs: AutomationRun[];
  onCardClick: () => void;
  onExpand: () => void;
  onRun: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onWorkbench: () => void;
  onDelete: () => void;
  t: (k: string) => string;
}) {
  const schedule = triggerLabel(a, t);
  const isScheduled = a.triggerType !== 'manual' && a.enabled;
  const isDisabled = a.triggerType !== 'manual' && !a.enabled;
  const isDone = a.status === 'done';
  const isFailed = a.status === 'failed';
  const canRun = a.status === 'idle' || a.status === 'failed';

  const dotClass = isFailed ? 'tone-danger tone-bg'
    : isDone ? 'tone-success tone-bg'
    : isScheduled ? 'tone-warning tone-bg'
    : 'bg-gray-500';

  // Status tag text & style
  const statusTag = isFailed
    ? { text: t('status_failed'), cls: 'tone-danger' }
    : isDone
    ? { text: t('status_done'), cls: 'tone-success' }
    : isScheduled && schedule
    ? { text: schedule, cls: 'tone-warning' }
    : isDisabled && schedule
    ? { text: `${schedule} (off)`, cls: 'tone-muted line-through' }
    : a.triggerType === 'manual'
    ? { text: t('manual'), cls: 'tone-muted' }
    : null;

  const handleRowClick = () => {
    if (a.sessionId && (isDone || a.status === 'running')) {
      onCardClick();
    } else {
      onExpand();
    }
  };

  return (
    <div className={isDisabled ? 'opacity-50' : ''}>
      {/* Main row */}
      <div
        className={`group grid cursor-pointer grid-cols-[auto_1fr_auto_auto] items-center gap-x-2 gap-y-1.5 rounded-lg px-3 py-2.5 transition-colors hover:bg-surface-850 sm:flex sm:gap-2.5 ${expanded ? 'bg-surface-850' : ''}`}
        onClick={handleRowClick}
      >
        {/* Status dot */}
        <span className={`w-[7px] h-[7px] rounded-full flex-shrink-0 ${dotClass}`} />

        {/* Name */}
        <span className="min-w-0 truncate text-[15px] text-gray-200 sm:flex-1">{a.name}</span>

        {/* Creator badge */}
        {a.creatorName && (
          <span
            className="hidden text-[11px] px-1.5 py-0.5 rounded bg-surface-700/60 text-gray-500 font-medium flex-shrink-0 sm:inline"
            title={`Created by ${a.creatorName}`}
          >
            @{a.creatorName}
          </span>
        )}

        {/* Status tag — always visible */}
        {statusTag && (
          <span className={`tone-pill col-start-2 row-start-2 w-fit max-w-full truncate rounded px-1.5 py-0.5 text-[12px] sm:col-auto sm:row-auto sm:flex-shrink-0 ${statusTag.cls}`}>
            {statusTag.text}
          </span>
        )}

        {/* Run button — always visible for runnable items */}
        {canRun && (
          <button
            onClick={(e) => { e.stopPropagation(); onRun(); }}
            className="col-start-3 row-span-2 row-start-1 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md border border-blue-500/30 bg-blue-500/10 text-[13px] text-blue-400 transition-all hover:border-blue-500 hover:bg-blue-600 hover:text-white sm:h-7 sm:w-7"
            title={t('runNow')}
          >
            ▶
          </button>
        )}

        {/* "View session" button for done items */}
        {a.sessionId && isDone && (
          <button
            onClick={(e) => { e.stopPropagation(); onCardClick(); }}
            className="col-start-3 row-span-2 row-start-1 rounded border border-surface-600 bg-surface-800 px-2 py-1 text-[12px] text-gray-400 transition-colors hover:bg-surface-700 hover:text-gray-200 sm:col-auto sm:row-auto sm:flex-shrink-0"
          >
            {t('view')}
          </button>
        )}

        {/* Toggle (for scheduled items) */}
        {a.triggerType !== 'manual' && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            className={`relative col-start-3 row-span-2 row-start-1 h-[22px] w-10 flex-shrink-0 rounded-full transition-colors sm:col-auto sm:row-auto sm:h-[18px] sm:w-8 ${a.enabled ? 'tone-success tone-bg' : 'bg-surface-600'}`}
          >
            <span className={`absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white transition-transform sm:h-[14px] sm:w-[14px] ${a.enabled ? 'left-[20px] sm:left-[16px]' : 'left-[2px]'}`} />
          </button>
        )}

        {/* Expand indicator */}
        <svg className={`col-start-4 row-span-2 row-start-1 h-3.5 w-3.5 flex-shrink-0 text-gray-600 transition-transform sm:col-auto sm:row-auto ${expanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="mx-0 mb-2 rounded-lg border border-surface-700/50 bg-surface-800/50 px-3 py-3 sm:mx-3">
          {/* Prompt — prominent */}
          {a.prompt && (
            <div className="mb-3">
              <p className="text-[13px] text-gray-500 mb-1">{t('prompt')}</p>
              <p className="text-sm text-gray-300 leading-relaxed bg-surface-850 rounded-md px-3 py-2 border border-surface-700/30">
                {a.prompt}
              </p>
            </div>
          )}

          {/* Meta row */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-gray-500 mb-3">
            {a.mode !== 'spawn' && (
              <span>{t('mode')}: <span className="text-gray-400">{a.mode === 'inject' ? t('session') : t('channel')}</span></span>
            )}
            {a.lastRunAt && (
              <span>{t('lastRun')}: <span className="text-gray-400">{new Date(a.lastRunAt).toLocaleString()}</span></span>
            )}
            {a.runCount > 0 && (
              <span>{a.runCount} {t('runs')}</span>
            )}
            {a.lastStatus === 'error' && a.lastError && (
              <span className="text-red-400 truncate max-w-[200px]">{a.lastError}</span>
            )}
          </div>

          {/* Recent runs */}
          {runs.length > 0 && (
            <div className="mb-3 space-y-0.5">
              <p className="text-[13px] text-gray-500 mb-1">{t('runLog')}</p>
              {runs.map(r => (
                <div key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px]">
                  <span className={`w-1.5 h-1.5 rounded-full ${r.status === 'success' ? 'tone-success tone-bg' : 'tone-danger tone-bg'}`} />
                  <span className="text-gray-500">{new Date(r.ranAt).toLocaleString()}</span>
                  {r.durationMs != null && <span className="text-gray-600">{(r.durationMs / 1000).toFixed(1)}s</span>}
                  {r.error && <span className="text-red-400 truncate max-w-[180px]">{r.error}</span>}
                </div>
              ))}
            </div>
          )}

          {/* Action buttons — prominent Run + secondary edit/delete */}
          <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
            {canRun && (
              <button
                onClick={onRun}
                className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors font-medium"
              >
                ▶ {t('runNow')}
              </button>
            )}
            <button onClick={onWorkbench} className="text-[13px] px-2.5 py-1.5 rounded-md border border-blue-500/30 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 transition-colors">
              Workbench
            </button>
            <button onClick={onEdit} className="text-[13px] px-2.5 py-1.5 rounded-md border border-surface-600 bg-surface-800 text-gray-300 hover:bg-surface-700 transition-colors">
              {t('edit')}
            </button>
            <button onClick={onDelete} className="text-[13px] px-2.5 py-1.5 rounded-md border border-red-500/20 text-red-400 hover:bg-red-500/10 transition-colors">
              {t('delete')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


// ── Create/Edit Form Modal ──

function AutomationFormModal({ editingId, onClose, onSaved, t }: {
  editingId: string | null; onClose: () => void; onSaved: () => void; t: (k: string) => string;
}) {
  const claudeModels = useModelStore((s) => s.availableModels);
  const piModels = useModelStore((s) => s.piModels);
  const defaults = useModelStore((s) => s.defaults);
  const modelOptions = [
    ...claudeModels.map((m) => ({ id: m.id, name: m.name, group: 'Claude' })),
    ...piModels.map((m) => ({ id: m.id.replace(/^pi:/, ''), name: m.name, group: 'AI Router' })),
  ];
  const defaultAutomationModel = defaults.session.startsWith('pi:') ? defaults.session.slice(3) : defaults.session;

  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState(defaultAutomationModel || 'litellm-responses/mini');
  const [mode, setMode] = useState<'spawn' | 'inject'>('spawn');
  const [triggerType, setTriggerType] = useState<'manual' | 'cron' | 'once'>('manual');
  const [cronType, setCronType] = useState<'daily' | 'weekdays' | 'weekly' | 'interval'>('daily');
  const [cronHour, setCronHour] = useState(9);
  const [cronMinute, setCronMinute] = useState(0);
  const [cronDay, setCronDay] = useState(1);
  const [cronIntervalHours, setCronIntervalHours] = useState(1);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editingId) return;
    fetchJson<Automation>(`${API}/${editingId}`).then((a) => {
      setName(a.name); setPrompt(a.prompt); setModel(a.model);
      setMode(a.mode === 'inject' ? 'inject' : 'spawn');
      setTriggerType(a.triggerType === 'event' ? 'manual' : a.triggerType);
      if (a.cronConfig) {
        setCronType(a.cronConfig.type);
        setCronHour(a.cronConfig.hour ?? 9); setCronMinute(a.cronConfig.minute ?? 0);
        setCronDay(a.cronConfig.day ?? 1); setCronIntervalHours(a.cronConfig.hours ?? 1);
      }
    }).catch(() => {});
  }, [editingId]);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const cronConfig = triggerType === 'cron' ? {
        type: cronType,
        ...(cronType !== 'interval' ? { hour: cronHour, minute: cronMinute } : {}),
        ...(cronType === 'weekly' ? { day: cronDay } : {}),
        ...(cronType === 'interval' ? { hours: cronIntervalHours } : {}),
      } : undefined;
      const body = {
        name,
        prompt,
        model,
        mode,
        triggerType,
        cronConfig,
      };
      if (editingId) {
        throw new Error(t('workbenchEditRequired'));
      }
      await fetchJson(API, { method: 'POST', body: JSON.stringify(body) });
      onSaved();
    } catch (err: any) { toastError(err.message); } finally { setSaving(false); }
  };

  const inputCls = 'w-full px-3 py-2 text-base rounded-md bg-surface-800 border border-surface-700 text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500';
  const labelCls = 'block text-sm font-medium text-gray-400 mb-1';

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
      <div className="flex max-h-[calc(100dvh-3rem)] w-full flex-col rounded-t-2xl border border-surface-700 bg-surface-900 shadow-2xl sm:max-w-md sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700">
          <h3 className="text-base font-semibold text-gray-200">
            {editingId ? t('editAutomation') : t('createAutomation')}
          </h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 sm:max-h-[60vh]">
          <div>
            <label className={labelCls}>{t('name')}</label>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} />
          </div>
          <div>
            <label className={labelCls}>{t('prompt')}</label>
            <textarea className={`${inputCls} h-20 resize-none`} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t('promptPlaceholder')} />
          </div>

          {/* Mode */}
          <div>
            <label className={labelCls}>{t('mode')}</label>
            <div className="flex gap-1.5">
              {(['spawn', 'inject'] as const).map(m => (
                <button key={m} onClick={() => setMode(m)}
                  className={`flex-1 px-2 py-1.5 text-sm rounded-md border transition-colors ${
                    mode === m ? 'border-blue-500 bg-blue-500/10 text-blue-700 dark:text-blue-300' : 'border-surface-700 bg-surface-800 text-gray-400 hover:bg-surface-700'
                  }`}>
                  {t(`mode_${m}`)}
                </button>
              ))}
            </div>
          </div>


          {/* Trigger */}
          <div>
            <label className={labelCls}>{t('trigger')}</label>
            <div className="flex gap-1.5">
              {(['manual', 'cron', 'once'] as const).map(tr => (
                <button key={tr} onClick={() => setTriggerType(tr)}
                  className={`flex-1 px-2 py-1.5 text-sm rounded-md border transition-colors ${
                    triggerType === tr ? 'border-blue-500 bg-blue-500/10 text-blue-700 dark:text-blue-300' : 'border-surface-700 bg-surface-800 text-gray-400 hover:bg-surface-700'
                  }`}>
                  {t(`trigger_${tr}`)}
                </button>
              ))}
            </div>
          </div>

          {/* Cron config */}
          {triggerType === 'cron' && (
            <div className="space-y-2 p-3 rounded-lg bg-surface-800 border border-surface-700">
              <select className={inputCls} value={cronType} onChange={(e) => setCronType(e.target.value as any)}>
                <option value="daily">{t('daily')}</option>
                <option value="weekdays">{t('weekdays')}</option>
                <option value="weekly">{t('weekly')}</option>
                <option value="interval">{t('everyNHours')}</option>
              </select>
              {cronType !== 'interval' ? (
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className={labelCls}>{t('at')}</label>
                    <div className="flex gap-1">
                      <input type="number" min={0} max={23} className={`${inputCls} w-16`} value={cronHour} onChange={(e) => setCronHour(+e.target.value)} />
                      <span className="text-gray-500 self-center">:</span>
                      <input type="number" min={0} max={59} className={`${inputCls} w-16`} value={cronMinute} onChange={(e) => setCronMinute(+e.target.value)} />
                    </div>
                  </div>
                  {cronType === 'weekly' && (
                    <div className="flex-1">
                      <label className={labelCls}>{t('dayOfWeek')}</label>
                      <select className={inputCls} value={cronDay} onChange={(e) => setCronDay(+e.target.value)}>
                        {[t('sun'),t('mon'),t('tue'),t('wed'),t('thu'),t('fri'),t('sat')].map((d,i) => (
                          <option key={i} value={i}>{d}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <label className={labelCls}>{t('intervalHours')}</label>
                  <input type="number" min={1} max={72} className={inputCls} value={cronIntervalHours} onChange={(e) => setCronIntervalHours(+e.target.value)} />
                </div>
              )}
            </div>
          )}

          {/* Model */}
          <div>
            <label className={labelCls}>{t('model')}</label>
            <select className={inputCls} value={model} onChange={(e) => setModel(e.target.value)}>
              {['Claude', 'Pi'].map((group) => {
                const options = modelOptions.filter((m) => m.group === group);
                if (options.length === 0) return null;
                return (
                  <optgroup key={group} label={group}>
                    {options.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </optgroup>
                );
              })}
            </select>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-surface-700 px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] sm:pb-3">
          <button onClick={onClose} className="px-3 py-1.5 text-base bg-surface-800 hover:bg-surface-700 text-gray-300 rounded-lg transition-colors">
            {t('cancel')}
          </button>
          <button onClick={handleSave} disabled={!name.trim() || saving}
            className="px-3 py-1.5 text-base bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50">
            {saving ? t('saving') : editingId ? t('save') : t('create')}
          </button>
        </div>
      </div>
    </div>
  );
}
