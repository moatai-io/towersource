import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Automation } from '@tower/shared';

type Trigger = { type: 'manual' } | { type: 'cron'; config: { type: 'daily'; hour: number; minute: number } } | { type: 'once'; at: string };
type Plan = {
  kind: 'plan'; automation: Automation; proposalHash: string; expiresAt: string;
  projectName: string; modelMode: 'core' | 'session'; runtimeModel: string; nextRunAt: string | null;
  nextRunTimes: string[]; readiness: {
    workspace: 'active'; createPermission: 'allowed'; modelSelection: 'selectable';
    agentExecutionAccess: 'allowed'; workspacePath: 'accessible';
    executionAndProvider: 'not_verified'; dataAndWriteScope: 'not_verified';
  }; warnings: string[];
};
type Preview = Plan | { kind: 'clarification' | 'unsupported'; message: string };
async function api<T>(url: string, body: object): Promise<T> {
  const token = localStorage.getItem('token');
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}
export function AutomationCreatePanel({ projects, initialProjectId, sourceSessionId, initialRequest = '', onCancel, onCreated }: {
  projects: { id: string; name: string }[]; initialProjectId?: string; sourceSessionId?: string | null; initialRequest?: string;
  onCancel: () => void; onCreated: (automation: Automation) => void;
}) {
  const { t } = useTranslation('automation');
  const [projectId, setProjectId] = useState(initialProjectId || projects[0]?.id || '');
  const [request, setRequest] = useState(initialRequest);
  const [modelMode, setModelMode] = useState<'core' | 'session'>('core');
  const [timezone, setTimezone] = useState('Asia/Seoul');
  const [timing, setTiming] = useState('request');
  const [clock, setClock] = useState('09:00');
  const [onceAt, setOnceAt] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [confirmed, setConfirmed] = useState(false);
  const formClass = 'w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-sm text-surface-100';
  const readyToActivate = plan?.readiness?.workspace === 'active'
    && plan.readiness.createPermission === 'allowed'
    && plan.readiness.modelSelection === 'selectable'
    && plan.readiness.agentExecutionAccess === 'allowed'
    && plan.readiness.workspacePath === 'accessible';
  function invalidate() { setPlan(null); setConfirmed(false); setMessage(null); }
  async function preview() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); invalidate();
    try {
      let trigger: Trigger | undefined;
      if (timing === 'manual') trigger = { type: 'manual' };
      if (timing === 'daily') {
        const [hour, minute] = clock.split(':').map(Number);
        if (!Number.isFinite(hour) || !Number.isFinite(minute)) throw new Error(t('planInvalidTime'));
        trigger = { type: 'cron', config: { type: 'daily', hour, minute } };
      }
      if (timing === 'once') {
        // Require explicit offset; never interpret a host/browser-local clock as the selected IANA zone.
        if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(onceAt) || !Number.isFinite(Date.parse(onceAt))) throw new Error(t('planOnceOffset'));
        trigger = { type: 'once', at: onceAt };
      }
      const result = await api<Preview>('/api/automations/creation-plans', { request, projectId, modelMode, timezone,
        ...(modelMode === 'session' && sourceSessionId ? { sourceSessionId } : {}), ...(trigger ? { trigger } : {}) });
      if (result.kind === 'plan') setPlan(result);
      else setMessage(result.message);
    } catch (error) { setMessage(error instanceof Error ? error.message : t('planPreviewFailed')); }
    finally { setBusy(false); inFlight.current = false; }
  }
  async function activate() {
    if (!plan || !confirmed || inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setMessage(null);
    try {
      const response = await api<{ automation: Automation }>(`/api/automations/creation-plans/${encodeURIComponent(plan.automation.id)}/activate`, { proposalHash: plan.proposalHash, confirmed: true });
      onCreated(response.automation);
    } catch (error) { setMessage(error instanceof Error ? error.message : t('planActivationFailed')); }
    finally { setBusy(false); inFlight.current = false; }
  }
  return <section aria-label={t('planCreateTitle')} className="m-4 max-h-[75vh] overflow-y-auto rounded-xl border border-surface-700 bg-surface-900 p-5 [word-break:keep-all]">
    <h2 className="text-base font-semibold text-surface-100">{t('planCreateTitle')}</h2>
    <p className="mt-1 text-sm leading-6 text-surface-400">{t('planCreateHint')}</p>
    {message && <p role="alert" className="my-3 text-sm text-warning-400">{message}</p>}
    <fieldset disabled={busy} className="mt-4 space-y-3 disabled:opacity-60">
      <label className="block text-sm text-surface-300">{t('planWorkspace')}<select value={projectId} onChange={e => { invalidate(); setProjectId(e.target.value); }} className={formClass}>
        {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>
      <label className="block text-sm text-surface-300">{t('planRequest')}<textarea value={request} onChange={e => { invalidate(); setRequest(e.target.value); }} rows={3} maxLength={8000} placeholder={t('planRequestExample')} className={formClass} /></label>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <label className="text-sm text-surface-300">{t('planTiming')}<select value={timing} onChange={e => { invalidate(); setTiming(e.target.value); }} className={formClass}>
          <option value="request">{t('planTimingRequest')}</option><option value="manual">{t('planTimingManual')}</option><option value="daily">{t('planTimingDaily')}</option><option value="once">{t('planTimingOnce')}</option>
        </select></label>
        <label className="text-sm text-surface-300">{t('planTimezone')}<input value={timezone} onChange={e => { invalidate(); setTimezone(e.target.value); }} className={formClass} /></label>
        <label className="text-sm text-surface-300">{t('planModel')}<select value={modelMode} onChange={e => { invalidate(); setModelMode(e.target.value as 'core' | 'session'); }} className={formClass}>
          <option value="core">{t('planCore')}</option><option disabled={!sourceSessionId} value="session">{t('planSessionModel')}</option>
        </select></label>
      </div>
      {timing === 'daily' && <label className="block text-sm text-surface-300">{t('planClock')}<input type="time" value={clock} onChange={e => { invalidate(); setClock(e.target.value); }} className={formClass} /></label>}
      {timing === 'once' && <label className="block text-sm text-surface-300">{t('planOnceOffset')}<input value={onceAt} placeholder="2030-01-01T09:00:00+09:00" onChange={e => { invalidate(); setOnceAt(e.target.value); }} className={formClass} /></label>}
      {plan && <div className="border-t border-surface-700 pt-4">
        <h3 className="font-semibold text-surface-100">{t('planReviewTitle')}</h3>
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm text-surface-300">
          <dt>{t('planWorkspace')}</dt><dd>{plan.projectName}</dd>
          <dt>{t('planRequest')}</dt><dd className="whitespace-pre-wrap break-words">{plan.automation.prompt}</dd>
          <dt>{t('planTiming')}</dt><dd>{plan.automation.triggerType === 'manual' ? t('planTimingManual') : plan.automation.triggerType === 'once' ? t('planTimingOnce') : plan.automation.cronConfig?.type === 'interval' ? `${plan.automation.cronConfig.minutes ?? (plan.automation.cronConfig.hours || 1) * 60} ${t('planMinutes')}` : `${t(`planFrequency.${plan.automation.cronConfig?.type}`)} ${plan.automation.cronConfig?.type === 'weekly' ? t(`planDays.${plan.automation.cronConfig.day ?? 1}`) : ''} ${String(plan.automation.cronConfig?.hour ?? 9).padStart(2, '0')}:${String(plan.automation.cronConfig?.minute ?? 0).padStart(2, '0')}`} ({plan.automation.timezone})</dd>
          <dt>{t('planNextRuns')}</dt><dd>{plan.nextRunTimes.length > 0 ? <ol data-testid="plan-next-runs" className="space-y-1">{plan.nextRunTimes.map(time => <li key={time}>{new Intl.DateTimeFormat(undefined, { timeZone: plan.automation.timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(time))}</li>)}</ol> : t('planManualNoNext')}</dd>
          <dt>{t('planModel')}</dt><dd className="break-all">{plan.modelMode === 'core' ? t('planCore') : t('planSessionModel')} · {plan.automation.model} · {plan.runtimeModel}</dd>
          <dt>{t('planReadiness')}</dt><dd className="space-y-1"><p>{readyToActivate ? t('planReadyChecked') : t('planReadinessUnavailable')}</p><p className="text-amber-300">{t('planReadyUnverified')}</p></dd>
          <dt>{t('planResult')}</dt><dd>{t('planResultLocation')}</dd>
          <dt>{t('planExpiry')}</dt><dd>{new Date(plan.expiresAt).toLocaleTimeString()}</dd>
        </dl>
        <ul className="mt-3 space-y-1 text-sm leading-6 text-surface-400">{plan.warnings.map(w => <li key={w}>{w}</li>)}</ul>
        <label className="mt-4 flex items-start gap-2 text-sm text-surface-200"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} className="mt-1" />{t('planConfirmation')}</label>
      </div>}
    </fieldset>
    <div className="mt-4 flex flex-wrap justify-end gap-2">
      <button disabled={busy} onClick={onCancel} className="rounded-lg border border-surface-700 px-3 py-2 text-sm text-surface-300">{t('planCancel')}</button>
      {plan ? <button disabled={busy || !confirmed || !readyToActivate} onClick={() => void activate()} className="rounded-lg bg-primary-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? t('planSaving') : t('planActivate')}</button>
        : <button disabled={busy || !request.trim() || !projectId} onClick={() => void preview()} className="rounded-lg bg-primary-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? t('planChecking') : t('planPreview')}</button>}
    </div>
  </section>;
}
