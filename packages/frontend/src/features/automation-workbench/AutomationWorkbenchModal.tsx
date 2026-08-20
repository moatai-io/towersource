import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Automation, SessionMeta } from '@tower/shared';
import { useSessionStore } from '../../stores/session-store';
import { useAiPanelStore } from '../../stores/ai-panel-store';
import { openTowerFile } from '../../utils/file-path-links';
import { useConfirm } from '../../hooks/useDialog';
import {
  automationYamlDraft,
  validateAutomationYamlV1,
  type AutomationConditionEvaluation,
  type AutomationYamlValidationResult,
} from './automation-yaml';

const API = '/api/automations';

type AsyncState = 'idle' | 'running' | 'done' | 'error';

type ObserveState = {
  status: AsyncState;
  message: string | null;
  stdout?: string | null;
  stderr?: string | null;
};

type ConditionState = {
  status: AsyncState;
  result?: AutomationConditionEvaluation;
  message: string | null;
};

type SaveState = {
  status: 'idle' | 'saving' | 'saved' | 'error';
  message: string | null;
  path?: string;
};

type EditorThreadState = {
  status: AsyncState;
  message: string | null;
  sessionId?: string;
};

type ChangeIntent = {
  id: string;
  automationId: string;
  baseConfigUpdatedAt: string;
  proposalHash: string;
  riskLevel: 'low' | 'medium' | 'high';
  warnings: string[];
  summary: string | null;
  status: string;
  expiresAt: string;
  applyingByUserId?: number | null;
  applyingAt?: string | null;
  error?: string | null;
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
    case 'interval': return t('triggerInterval', { value: c.minutes ?? c.hours ?? 1, unit: c.minutes ? t('minutesUnit') : t('hoursUnit') });
    default: return '';
  }
}

function runKind(a: Automation, t: (key: string) => string): string {
  if (a.jobType === 'shell') return t('kindShell');
  if (a.jobType === 'script') return t('kindScript');
  if (a.jobType === 'webhook') return t('kindWebhook');
  if (a.jobType === 'monitor') return t('kindMonitor');
  return t('kindAiPrompt');
}

function WorkbenchCard({ title, eyebrow, value, detail }: { title: string; eyebrow: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-surface-800 dark:bg-surface-900/60">
      <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500 dark:text-surface-500">{eyebrow}</div>
      <div className="mt-2 text-sm font-semibold text-slate-950 dark:text-surface-100">{title}</div>
      <div className="mt-1 text-base font-semibold text-blue-700 dark:text-blue-200">{value}</div>
      <div className="mt-2 text-xs leading-relaxed text-slate-600 dark:text-surface-400">{detail}</div>
    </div>
  );
}

function ResultBox({ state }: { state: ObserveState | ConditionState | { status: AsyncState; message: string | null; wouldCallAi?: boolean } }) {
  if (!state.message) return null;
  const tone = state.status === 'error'
    ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200'
    : 'wouldCallAi' in state && state.wouldCallAi
      ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100'
      : 'border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-100';
  return <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${tone}`}><div className="font-semibold">{state.message}</div></div>;
}

export function AutomationWorkbenchModal({ automation: a, onClose, onOpenLegacyEdit, embedded = false, showAssistant = true }: {
  automation: Automation;
  onClose?: () => void;
  onOpenLegacyEdit: () => void;
  embedded?: boolean;
  showAssistant?: boolean;
}) {
  const { t } = useTranslation('automation');
  const confirm = useConfirm();
  const [message, setMessage] = useState('');
  const [showSource, setShowSource] = useState(false);
  const baseYaml = useMemo(() => automationYamlDraft(a, { triggerLabel: (automation) => triggerLabel(automation, t) }), [a, t]);
  const [yaml, setYaml] = useState(baseYaml);
  const [suggestion, setSuggestion] = useState<{ summary: string; yaml: string; changed: boolean } | null>(null);
  const [applyState, setApplyState] = useState<{ status: AsyncState; message: string | null }>({ status: 'idle', message: null });
  const [changeIntent, setChangeIntent] = useState<ChangeIntent | null>(null);
  const [intentDiagnostics, setIntentDiagnostics] = useState<ChangeIntent[]>([]);
  const [threadState, setThreadState] = useState<{ status: AsyncState; message: string | null; session?: SessionMeta }>({ status: 'idle', message: null });
  const addSession = useSessionStore((s) => s.addSession);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const localValidation = useMemo(() => validateAutomationYamlV1(yaml), [yaml]);
  const [serverValidation, setServerValidation] = useState<AutomationYamlValidationResult | null>(null);
  const [serverValidationError, setServerValidationError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle', message: null });
  const [observe, setObserve] = useState<ObserveState>({ status: 'idle', message: null });
  const [condition, setCondition] = useState<ConditionState>({ status: 'idle', message: null });
  const [full, setFull] = useState<{ status: AsyncState; message: string | null; wouldCallAi?: boolean }>({ status: 'idle', message: null });
  const validation = serverValidation || localValidation;

  useEffect(() => {
    setYaml(baseYaml);
    setSuggestion(null);
    setChangeIntent(null);
    setApplyState({ status: 'idle', message: null });
  }, [baseYaml]);

  useEffect(() => {
    let cancelled = false;
    setServerValidation(null);
    setServerValidationError(null);
    setSaveState({ status: 'idle', message: null });
    setObserve({ status: 'idle', message: null });
    setCondition({ status: 'idle', message: null });
    setFull({ status: 'idle', message: null });
    setChangeIntent(null);
    setApplyState({ status: 'idle', message: null });
    fetchJson<AutomationYamlValidationResult>(`${API}/validate-yaml`, { method: 'POST', body: JSON.stringify({ yaml }) })
      .then((result) => { if (!cancelled) setServerValidation(result); })
      .catch((err: any) => { if (!cancelled) setServerValidationError(err.message || 'server validation failed'); });
    return () => { cancelled = true; };
  }, [yaml]);

  useEffect(() => {
    let cancelled = false;
    fetchJson<ChangeIntent[]>(`${API}/${a.id}/change-intents/diagnostics`)
      .then((items) => { if (!cancelled) setIntentDiagnostics(items); })
      .catch(() => { if (!cancelled) setIntentDiagnostics([]); });
    return () => { cancelled = true; };
  }, [a.id, applyState.status]);

  const runObserve = async () => {
    setObserve({ status: 'running', message: t('observeRunning') });
    try {
      const r = await fetchJson<{ status: string; summaryText?: string | null; stdoutText?: string | null; stderrText?: string | null; error?: string | null }>(`${API}/${a.id}/observe-dry-run`, { method: 'POST' });
      setObserve({ status: r.status === 'success' || r.status === 'skipped' ? 'done' : 'error', message: r.summaryText || r.error || `observe ${r.status}`, stdout: r.stdoutText, stderr: r.stderrText });
    } catch (err: any) {
      setObserve({ status: 'error', message: err.message || t('observeFailed') });
    }
  };

  const runCondition = async () => {
    setCondition({ status: 'running', message: t('conditionRunning') });
    try {
      const r = await fetchJson<AutomationConditionEvaluation>(`${API}/${a.id}/condition-dry-run`, { method: 'POST', body: JSON.stringify({ yaml, stdoutText: observe.stdout || '' }) });
      setCondition({ status: r.errors.length ? 'error' : 'done', result: r, message: r.aiNeeded ? t('aiConditionMet') : t('aiConditionNotMet') });
    } catch (err: any) {
      setCondition({ status: 'error', message: err.message || t('conditionFailed') });
    }
  };

  const runFullPreview = async () => {
    setFull({ status: 'running', message: t('fullPreviewRunning') });
    try {
      const r = await fetchJson<{ observe: { status: string; summaryText?: string | null; stdoutText?: string | null; stderrText?: string | null; error?: string | null }; condition: AutomationConditionEvaluation; wouldCallAi: boolean }>(`${API}/${a.id}/full-dry-run`, { method: 'POST', body: JSON.stringify({ yaml }) });
      const observeStatus = r.observe.status === 'success' || r.observe.status === 'skipped' ? 'done' : 'error';
      setObserve({ status: observeStatus, message: r.observe.summaryText || r.observe.error || `observe ${r.observe.status}`, stdout: r.observe.stdoutText, stderr: r.observe.stderrText });
      setCondition({ status: r.condition.errors.length ? 'error' : 'done', result: r.condition, message: r.wouldCallAi ? t('aiConditionMet') : t('aiConditionNotMet') });
      setFull({ status: observeStatus, wouldCallAi: r.wouldCallAi, message: r.wouldCallAi ? t('fullPreviewAi') : t('fullPreviewNoAi') });
    } catch (err: any) {
      setFull({ status: 'error', message: err.message || t('fullPreviewFailed') });
    }
  };

  const suggestEdit = async () => {
    if (!message.trim()) return;
    setSuggestion({ summary: t('suggestionRunning'), yaml, changed: false });
    try {
      const r = await fetchJson<{ yaml: string; summary: string; changed: boolean; session?: SessionMeta }>(`${API}/${a.id}/editor-thread-message`, {
        method: 'POST',
        body: JSON.stringify({ yaml, instruction: message }),
      });
      if (r.session) {
        addSession(r.session);
        setThreadState({ status: 'done', message: t('threadMessageSaved'), session: r.session });
      }
      setSuggestion(r);
      if (r.changed) {
        setYaml(r.yaml);
        setShowSource(true);
      }
    } catch (err: any) {
      setSuggestion({ summary: err.message || t('suggestionFailed'), yaml, changed: false });
    }
  };

  const createChangeIntent = async () => {
    setApplyState({ status: 'running', message: t('changeIntentRunning') });
    try {
      const intent = await fetchJson<ChangeIntent>(`${API}/${a.id}/change-intents`, {
        method: 'POST',
        body: JSON.stringify({ yaml, summary: suggestion?.summary || message || null, sourceSessionId: a.sessionId || null }),
      });
      setChangeIntent(intent);
      const warning = intent.warnings.length ? t('warningCount', { count: intent.warnings.length }) : '';
      setApplyState({ status: 'done', message: t('changeDraftCreated', { risk: intent.riskLevel, warning }) });
    } catch (err: any) {
      setApplyState({ status: 'error', message: err.message || t('changeDraftFailed') });
    }
  };

  const reconcileChangeIntent = async (intent: ChangeIntent) => {
    const ok = await confirm({
      title: t('reconcileTitle'),
      message: t('reconcileConfirm'),
      confirmLabel: t('reconcileAction'),
      danger: true,
    });
    if (!ok) return;
    setApplyState({ status: 'running', message: t('reconcileRunning') });
    try {
      const result = await fetchJson<{ outcome: 'applied' | 'failed'; reason: string }>(`${API}/${a.id}/change-intents/${intent.id}/reconcile`, {
        method: 'POST',
        body: JSON.stringify({ confirmed: true }),
      });
      setApplyState({ status: result.outcome === 'applied' ? 'done' : 'error', message: result.outcome === 'applied' ? t('reconcileApplied') : t('reconcileFailedReason', { reason: result.reason }) });
    } catch (err: any) {
      setApplyState({ status: 'error', message: err.message || t('reconcileFailed') });
    }
  };

  const applyChangeIntent = async () => {
    if (!changeIntent) return;
    const highRisk = changeIntent.riskLevel === 'high';
    const ok = await confirm({
      title: highRisk ? t('applyHighRiskTitle') : t('applyTitle'),
      message: t('applyConfirm', { summary: changeIntent.summary || t('currentYamlChange'), risk: changeIntent.riskLevel, expires: new Date(changeIntent.expiresAt).toLocaleString(), warnings: changeIntent.warnings.length ? `\n${t('warnings')}: ${changeIntent.warnings.join('\n')}` : '' }),
      confirmLabel: t('applyChange'),
      danger: highRisk,
    });
    if (!ok) return;
    setApplyState({ status: 'running', message: t('applyRunning') });
    try {
      await fetchJson(`${API}/${a.id}/change-intents/${changeIntent.id}/apply`, {
        method: 'POST',
        body: JSON.stringify({ proposalHash: changeIntent.proposalHash, confirmedHighRisk: highRisk }),
      });
      setChangeIntent({ ...changeIntent, status: 'applied' });
      setApplyState({ status: 'done', message: t('applyDone') });
    } catch (err: any) {
      const detail = err.message || t('applyFailed');
      setApplyState({ status: 'error', message: /changed after|expired|unused/.test(detail) ? t('applyRefreshRequired', { detail }) : detail });
    }
  };

  const openEditorThread = async () => {
    setThreadState({ status: 'running', message: t('conversationPreparing') });
    try {
      const r = await fetchJson<{ session: SessionMeta; created: boolean }>(`${API}/${a.id}/editor-thread`, {
        method: 'POST',
        body: JSON.stringify({ parentSessionId: activeSessionId || undefined }),
      });
      addSession(r.session);
      const panelContextId = r.session.parentSessionId || activeSessionId || r.session.id;
      const store = useAiPanelStore.getState();
      store.setContext('session', panelContextId, {
        path: `automation:${a.id}`,
        title: a.name,
        language: 'automation',
      });
      store.addThread({ ...r.session, aiPanelScope: 'session' });
      store.setActiveThreadId(r.session.id);
      store.setMessages([]);
      store.setPendingQuestion(null);
      store.setOpen(true);
      setThreadState({ status: 'done', message: r.created ? t('conversationCreated') : t('conversationOpened'), session: r.session });
    } catch (err: any) {
      setThreadState({ status: 'error', message: err.message || t('conversationOpenFailed') });
    }
  };

  const saveYaml = async () => {
    setSaveState({ status: 'saving', message: t('saveRunning') });
    try {
      const r = await fetchJson<{ path: string; relativePath: string }>(`${API}/${a.id}/save-yaml`, { method: 'POST', body: JSON.stringify({ yaml }) });
      setSaveState({ status: 'saved', message: `${r.relativePath} ${t('savedSuffix')}`, path: r.path });
    } catch (err: any) {
      setSaveState({ status: 'error', message: err.message || t('saveFailed') });
    }
  };

  const kind = runKind(a, t);
  const conditionText = a.jobType === 'ai_prompt' ? t('conditionTextAi') : t('conditionTextGate');

  return (
    <div className={embedded ? 'w-full' : 'fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/50 p-3 sm:p-5'} onClick={embedded ? undefined : onClose}>
      <div className={embedded ? 'w-full rounded-2xl border border-slate-200 bg-white text-slate-900 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100' : 'my-3 w-full max-w-7xl rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-2xl dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100'} onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-slate-200 bg-white/95 px-5 py-4 backdrop-blur dark:border-surface-800 dark:bg-surface-950/95">
          <div className="min-w-0">
            <div className="text-[12px] font-bold uppercase tracking-[0.16em] text-blue-700 dark:text-blue-300">{t('workbenchTitle')}</div>
            <h2 className="mt-1 truncate text-xl font-semibold text-slate-950 dark:text-surface-100">{a.name}</h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-surface-400">{t('headerDescription')}</p>
          </div>
          {!embedded && <button onClick={onClose} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 dark:border-surface-700 dark:text-surface-300 dark:hover:bg-surface-850 dark:hover:text-surface-100">{t('close')}</button>}
        </div>

        <div className={showAssistant ? 'grid gap-0 xl:grid-cols-[minmax(0,1.1fr)_minmax(380px,0.9fr)]' : 'grid gap-0'}>
          <div className="space-y-4 p-5">
            <div className="grid grid-cols-2 gap-3">
              <WorkbenchCard title={t('whenCheck')} eyebrow={t('startCondition')} value={triggerLabel(a, t) || t('manualRun')} detail={a.triggerType === 'manual' ? t('manualOnlyDetail') : t('scheduledDetail')} />
              <WorkbenchCard title={t('whatCheck')} eyebrow={t('checkTarget')} value={kind} detail={a.cwd ? t('workingDirectory', { path: a.cwd }) : t('defaultProjectLocation')} />
              <WorkbenchCard title={t('whenAi')} eyebrow={t('interventionCondition')} value={a.jobType === 'ai_prompt' ? t('alwaysAi') : t('onlyWhenNeeded')} detail={conditionText} />
              <WorkbenchCard title={t('whereReport')} eyebrow={t('reportLocation')} value={a.mode === 'channel' ? t('channelTarget') : a.mode === 'inject' ? t('existingSessionTarget') : t('newSessionTarget')} detail={t('reportingDetail')} />
            </div>

            <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 dark:border-blue-500/30 dark:bg-blue-500/10">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-blue-950 dark:text-blue-100">{t('previewFlowTitle')}</h3>
                  <p className="mt-1 text-sm text-blue-800/80 dark:text-blue-200/80">{t('previewFlowDescription')}</p>
                </div>
                <button disabled={full.status === 'running'} onClick={runFullPreview} className="shrink-0 rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-600 disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-400">{full.status === 'running' ? t('previewRunning') : t('previewFlow')}</button>
              </div>
              <ResultBox state={full} />
              {(observe.message || condition.message) && (
                <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                  {observe.message && <div className="rounded-lg border border-slate-200 bg-white p-2 text-slate-700 dark:border-surface-700 dark:bg-surface-950/40 dark:text-surface-300"><b>{t('checkResult')}</b><br />{observe.message}</div>}
                  {condition.message && <div className="rounded-lg border border-slate-200 bg-white p-2 text-slate-700 dark:border-surface-700 dark:bg-surface-950/40 dark:text-surface-300"><b>{t('aiJudgment')}</b><br />{condition.message}</div>}
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-2 border-t border-blue-200/70 pt-3 dark:border-blue-500/20">
                <button disabled={observe.status === 'running'} onClick={runObserve} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-surface-700 dark:bg-transparent dark:text-surface-300 dark:hover:bg-surface-850">{observe.status === 'running' ? t('checking') : t('viewCheck')}</button>
                <button disabled={condition.status === 'running'} onClick={runCondition} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-surface-700 dark:bg-transparent dark:text-surface-300 dark:hover:bg-surface-850">{condition.status === 'running' ? t('judging') : t('viewJudgment')}</button>
              </div>
              {observe.stdout && <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-white/70 p-2 text-[11px] text-slate-800 dark:bg-black/20 dark:text-surface-200">{observe.stdout}</pre>}
              {observe.stderr && <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-red-950/10 p-2 text-[11px] text-red-700 dark:text-red-200">{observe.stderr}</pre>}
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-surface-800 dark:bg-surface-900/60">
              <div className="mb-3 flex items-center justify-between">
                <button onClick={() => setShowSource(!showSource)} className="text-left"><h3 className="text-sm font-semibold text-slate-950 dark:text-surface-100">{t('advancedSource')} {showSource ? t('collapse') : t('view')}</h3><p className="mt-1 text-xs text-slate-600 dark:text-surface-400">{t('sourceDescription')}</p></button>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full border px-2 py-1 text-[11px] font-semibold ${validation.ok ? 'border-emerald-600/30 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200' : 'border-red-600/30 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200'}`}>{validation.ok ? t('saveAvailable') : t('needsChanges')}</span>
                  <span className="text-[11px] text-slate-500 dark:text-surface-500">{serverValidation ? t('validationDone') : serverValidationError ? t('localValidation') : t('validating')}</span>
                  <button disabled={!validation.ok || applyState.status === 'running'} onClick={createChangeIntent} className="rounded-lg border border-blue-600/30 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-800 hover:bg-blue-100 disabled:opacity-50 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200">{t('createReviewDraft')}</button>
                  <button disabled={!validation.ok || saveState.status === 'saving'} onClick={saveYaml} className="rounded-lg border border-emerald-600/30 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">{t('saveSource')}</button>
                  <button onClick={onOpenLegacyEdit} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-surface-700 dark:text-surface-300 dark:hover:bg-surface-850">{t('basicSettings')}</button>
                </div>
              </div>
              {applyState.message && <div className={`mb-3 rounded-lg border px-3 py-2 text-xs ${applyState.status === 'error' ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200' : 'border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-100'}`}>{applyState.message}</div>}
              {changeIntent && changeIntent.status === 'proposed' && <div className={`mb-3 rounded-xl border p-3 text-xs ${changeIntent.riskLevel === 'high' ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100' : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100'}`}><div className="font-semibold">{t('pendingApply', { risk: changeIntent.riskLevel })}</div><div className="mt-1 break-all opacity-80">{t('reviewHash')}: {changeIntent.proposalHash}</div><div className="mt-1">{t('expires')}: {new Date(changeIntent.expiresAt).toLocaleString()}</div>{changeIntent.warnings.length > 0 && <ul className="mt-2 list-disc pl-4">{changeIntent.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}<button disabled={applyState.status === 'running'} onClick={applyChangeIntent} className={`mt-3 rounded-lg px-3 py-2 font-semibold text-white disabled:opacity-50 ${changeIntent.riskLevel === 'high' ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-700 hover:bg-blue-600'}`}>{t('applyReviewedChange')}</button></div>}
              {intentDiagnostics.filter((intent) => intent.status === 'applying').map((intent) => <div key={intent.id} className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"><div>{t('interruptedChange')}</div><div className="mt-1 opacity-75">{t('applyStarted')}: {intent.applyingAt ? new Date(intent.applyingAt).toLocaleString() : t('recordedNone')}</div><button disabled={applyState.status === 'running' || !intent.applyingAt || Date.now() - new Date(intent.applyingAt).getTime() < 120000} onClick={() => reconcileChangeIntent(intent)} className="mt-2 rounded-md border border-amber-600/40 px-2 py-1 font-semibold disabled:opacity-50">{t('reconcile')}</button></div>)}
              {saveState.message && <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200"><span className="min-w-0 truncate">{saveState.message}</span>{saveState.path && <button onClick={() => openTowerFile(saveState.path!)} className="shrink-0 rounded-md border border-emerald-600/30 px-2 py-1 font-semibold">{t('openFile')}</button>}</div>}
              {(serverValidationError || validation.issues.length > 0) && <div className="mb-3 space-y-1 rounded-lg border border-surface-300 bg-white p-2 text-xs dark:border-surface-800 dark:bg-surface-950/60">{serverValidationError && <div className="text-amber-700 dark:text-amber-300"><b>{t('server')}</b>: {serverValidationError}. {t('serverValidationFallback')}</div>}{validation.issues.slice(0, 4).map((issue, index) => <div key={`${issue.path}-${index}`} className={issue.severity === 'error' ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300'}><b>{issue.path}</b>: {issue.message}</div>)}</div>}
              {showSource && <textarea value={yaml} onChange={(e) => setYaml(e.target.value)} className="h-[360px] w-full resize-y rounded-lg border border-slate-200 bg-white p-3 font-mono text-xs leading-relaxed text-slate-800 outline-none focus:border-blue-500 dark:border-surface-800 dark:bg-surface-950 dark:text-surface-300" />}
            </div>
          </div>

          {showAssistant && <div className="flex min-h-[420px] flex-col border-t border-slate-200 bg-slate-50/70 xl:border-l xl:border-t-0 dark:border-surface-800 dark:bg-surface-900/50">
            <div className="border-b border-slate-200 p-4 dark:border-surface-800">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-950 dark:text-surface-100">{t('automationConversation')}</h3>
                  <p className="mt-1 text-xs text-slate-600 dark:text-surface-400">{t('conversationDescription')}</p>
                </div>
                {a.sessionId && <span className="shrink-0 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-200">{t('connected')}</span>}
              </div>
            </div>
            <div className="flex-1 p-4">
              <div className="rounded-2xl border border-blue-200 bg-white p-4 shadow-sm dark:border-blue-500/25 dark:bg-surface-850">
                <div className="flex items-start gap-3">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-blue-600 text-white">AI</div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-950 dark:text-surface-100">{t('conversationCardTitle')}</div>
                    <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-surface-400">{t('conversationCardDescription', { trigger: triggerLabel(a, t) || t('manual'), kind })}</p>
                    <div className="mt-3 grid gap-2 text-xs">
                      {[t('exampleQuiet'), t('exampleConditions'), t('exampleSafer')].map((example) => (
                        <button key={example} onClick={() => setMessage(example)} className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-left text-slate-700 hover:border-blue-300 hover:bg-blue-50 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-300 dark:hover:bg-blue-500/10">{example}</button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {message && <div className="mt-3 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:border-blue-500/25 dark:bg-blue-500/10 dark:text-blue-100">{t('selectedExample')}: {message}</div>}
              {threadState.message && <div className={`mt-3 rounded-xl border px-3 py-2 text-xs ${threadState.status === 'error' ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-100' : 'border-slate-300 bg-white text-slate-800 dark:border-surface-700 dark:bg-surface-850 dark:text-surface-200'}`}>{threadState.message}</div>}
            </div>
            <div className="border-t border-slate-200 p-3 dark:border-surface-800">
              <button disabled={threadState.status === 'running'} onClick={openEditorThread} className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50">
                {threadState.status === 'running' ? t('openingConversation') : a.sessionId ? t('openConversation') : t('startConversation')}
              </button>
            </div>
          </div>}
        </div>
      </div>
    </div>
  );
}
