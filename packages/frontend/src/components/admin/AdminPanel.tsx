import { BrowserFileCanaryButton } from './BrowserFileCanaryButton';
import { AiSettingsManagement } from './model-management/ModelManagement';
import { UserManagement } from './UserManagement';
import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { useSettingsStore } from '../../stores/settings-store';
import { useConfirm } from '../../hooks/useDialog';
import { getCurrentRole } from '../../utils/auth';
import { RuntimeBoxPanel } from '../runtime/RuntimeBoxPanel';
import { UsagePanel } from '../usage/UsagePanel';

const API_BASE = '/api';

interface AdminPanelProps {
  open: boolean;
  onClose: () => void;
  token?: string | null;
}

interface PersonalCredentialsPanelProps {
  open: boolean;
  onClose: () => void;
  token?: string | null;
}

// 2026-05-04: AdminPanel 탭별 권한 (decisions/2026-05-04-five-role-model.md)
//   admin    → users / agents / usage / ai / runtime / credentials / system
//   operator → users / agents / usage / credentials / system (system is read-only)
// 2026-05-09: heartbeat 탭 제거 (decisions/2026-04-28-heartbeat-deprecation.md Phase 4)
// 2026-06-10: legacy organization groups removed; project_members is the only project access model.
// AI 모델 정책과 LiteLLM 카탈로그는 operator 이상에게 제공한다. 직접 연결/legacy 계정 관리 UI는 제거했다.
// 2026-05-31: AdminPanel skills tab removed. Skills are managed in the first-class Skills Market / registry UI,
// not a duplicate admin settings table that can bypass personal-first/project guards.
type AdminTab = 'users' | 'agents' | 'usage' | 'ai' | 'runtime' | 'credentials' | 'system';

const OPERATOR_ALLOWED_TABS: ReadonlySet<AdminTab> = new Set(['users', 'agents', 'usage', 'ai', 'credentials', 'system']);

function isTabAllowed(tab: AdminTab, role: string | null | undefined): boolean {
  if (role === 'admin') return true;
  if (role === 'operator') return OPERATOR_ALLOWED_TABS.has(tab);
  return false;
}

export function AdminPanel({ open, onClose, token }: AdminPanelProps) {
  const { t } = useTranslation('admin');
  // role 은 JWT payload 가 단일 source of truth (utils/auth.ts).
  const role = getCurrentRole() || 'member';
  const panelTitle = role === 'operator' ? t('operatorPanel') : t('adminPanel');
  const [tab, setTab] = useState<AdminTab>(() => new URLSearchParams(window.location.search).get('oauth') === 'google-organization' ? 'credentials' : 'users');

  // operator 가 진입 시 기본 탭이 허용되지 않으면 첫 허용 탭으로 이동
  useEffect(() => {
    if (open && !isTabAllowed(tab, role)) {
      setTab('users');
    }
  }, [open, tab, role]);

  if (!open) return null;

  const tabClass = (key: AdminTab) =>
    `min-h-11 shrink-0 whitespace-nowrap px-3 py-2 text-[14px] font-medium transition-colors border-b-2 sm:px-4 sm:text-[15px] ${
      tab === key
        ? 'text-primary-400 border-primary-500'
        : 'text-gray-500 hover:text-gray-300 border-transparent'
    }`;

  // helper: 탭이 현재 role 에 허용되어야만 렌더
  const renderTab = (key: AdminTab, label: string) => {
    if (!isTabAllowed(key, role)) return null;
    return (
      <button key={key} className={tabClass(key)} onClick={() => setTab(key)}>{label}</button>
    );
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-surface-900 border border-surface-700 rounded-xl shadow-2xl w-[calc(100vw-2rem)] max-w-[1600px] max-h-[calc(100dvh-1rem)] sm:max-h-[92vh] mx-4 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-surface-800 px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-primary-600/20 border border-primary-500/30 flex items-center justify-center">
              <svg className="w-4 h-4 text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <h2 className="truncate text-[18px] font-bold text-gray-100">{panelTitle}</h2>
          </div>
          <button onClick={onClose} aria-label={t('common:close')} className="flex min-h-11 min-w-11 items-center justify-center text-gray-500 hover:text-gray-300 hover:bg-surface-800 rounded-lg transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 overflow-x-auto border-b border-surface-800 px-2 sm:px-6">
          {renderTab('users', t('navigation.users'))}
          {renderTab('agents', t('navigation.agents'))}
          {renderTab('usage', t('navigation.usage'))}
          {renderTab('ai', t('navigation.ai'))}
          {renderTab('runtime', t('runtimeBoxTab'))}
          {renderTab('credentials', t('navigation.connections'))}
          {renderTab('system', t('navigation.system'))}
        </div>

        {/* Content — 허용 안 된 탭이 어쩌다 active 면 아무것도 안 그림 (안전망) */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-6">
          {isTabAllowed(tab, role) && (
            <>
              {tab === 'users' && <UserManagement token={token} />}
              {tab === 'agents' && <AgentLifecycleManagement token={token} />}
              {tab === 'usage' && <UsagePanel embedded />}
              {tab === 'ai' && <AiSettingsManagement token={token} canEditReasoning={role === 'admin' || role === 'operator'} />}
              {tab === 'runtime' && <RuntimeBoxPanel />}
              {tab === 'credentials' && <CredentialVaultManagement token={token} />}
              {tab === 'system' && <SystemInfo />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ───── Agent lifecycle tab ─────

type ManagedAgent = {
  id: string; name: string; isMember?: boolean; lifecycleStatus: string; retiredAt: string | null;
  retirementReason: string | null; ownerUsername: string | null;
  sessionCount: number; runtimeBoxCount: number;
  executionEnvironment?: { mode: 'canonical-project-workspace' | 'legacy-worker-workspace'; storageState: string | null };
  workstation?: { deploymentId: string; workerId: string | null; enabled: boolean; authorityMode: string };
};

type WorkstationWorker = {
  workerId: string; deploymentId: string; capabilities: string[]; projectIds: string[];
  capacity: { activeRuns: number; maxRuns: number }; status: 'healthy' | 'stale' | 'draining'; heartbeatAt: string;
};

type WorkstationChangePreview = {
  intentId: string; proposalHash: string; expiresAt: string;
  current: { defaultWorkerId: string | null; workstationMode: boolean; authorityMode: string } | null;
  target: WorkstationWorker & { projectAuthorized: boolean; transportConfigured: boolean; authorityMode: string };
  checks: Record<string, string>;
  impact: { rollbackWorkerId: string | null; bindingOnly: boolean; workerProcessChanged: boolean; runningCommandsInterrupted: boolean };
};

type WorkstationSmokeReceipt = {
  receiptHash: string; verifiedAt: string; workerId: string; checks: Record<string, string>;
};

type PurgePreview = {
  intentId: string; proposalHash: string; expiresAt: string; applyAvailable: false;
  impact: {
    projectId: string; projectName: string; lifecycleStatus: string; rootPath: string | null;
    folder: { exists: boolean; bytes: number | null; measurement: string };
    database: Record<string, number>;
    credentials: { dedicated: number; shared: number; reviewRequired: number };
    blockers: string[]; warnings: string[];
  };
};

function AgentLifecycleManagement({ token }: { token?: string | null }) {
  const { t } = useTranslation('admin');
  const confirm = useConfirm();
  const [status, setStatus] = useState<'active' | 'retired'>('active');
  const [agents, setAgents] = useState<ManagedAgent[]>([]);
  const [preview, setPreview] = useState<PurgePreview | null>(null);
  const [typedName, setTypedName] = useState('');
  const [purgeConfirmed, setPurgeConfirmed] = useState(false);
  const [purgeJob, setPurgeJob] = useState<{ id: string; status: string } | null>(null);
  const [workers, setWorkers] = useState<WorkstationWorker[]>([]);
  const [workstationAgent, setWorkstationAgent] = useState<ManagedAgent | null>(null);
  const [targetWorkerId, setTargetWorkerId] = useState('');
  const [workstationPreview, setWorkstationPreview] = useState<WorkstationChangePreview | null>(null);
  const [smokeReceipt, setSmokeReceipt] = useState<WorkstationSmokeReceipt | null>(null);
  const [workstationBusy, setWorkstationBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const headers = useCallback(() => ({
    'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }), [token]);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const joinAgent = async (agent: ManagedAgent) => {
    if (!await confirm({ title: t('agentLifecycle.joinTitle'), message: t('agentLifecycle.joinConfirm') })) return;
    setJoiningId(agent.id); setError('');
    try {
      const res = await fetch(`${API_BASE}/admin/agents/${agent.id}/join`, { method: 'POST', headers: headers() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('agentLifecycle.errors.joinAgent'));
      setAgents(current => current.map(a => a.id === agent.id ? { ...a, isMember: true } : a));
    } catch (err: any) { setError(err.message); }
    finally { setJoiningId(null); }
  };
  const refresh = useCallback(async () => {
    setLoading(true); setError(''); setPreview(null); setTypedName(''); setPurgeConfirmed(false); setPurgeJob(null);
    try {
      const res = await fetch(`${API_BASE}/admin/agents?status=${status}`, { headers: headers() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('agentLifecycle.errors.loadAgents'));
      setAgents(data.agents || []);
      if (status === 'active') {
        const workerRes = await fetch(`${API_BASE}/workbench-workers`, { headers: headers() });
        const workerData = await workerRes.json();
        if (workerRes.ok) setWorkers(Array.isArray(workerData) ? workerData : []);
      }
    } catch (err: any) { setError(err.message); } finally { setLoading(false); }
  }, [headers, status]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!purgeJob || ['completed', 'failed_before_destructive', 'recovery_required'].includes(purgeJob.status)) return;
    const timer = window.setInterval(async () => {
      const res = await fetch(`${API_BASE}/admin/agent-purge-jobs/${purgeJob.id}`, { headers: headers() });
      if (!res.ok) return;
      const data = await res.json();
      setPurgeJob({ id: data.id, status: data.status });
      if (data.status === 'completed') window.clearInterval(timer);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [headers, purgeJob]);
  const inspect = async (id: string) => {
    setError('');
    const res = await fetch(`${API_BASE}/admin/agents/${id}/purge/preview`, { method: 'POST', headers: headers(), body: '{}' });
    const data = await res.json();
    if (!res.ok) { setError(data.error || t('agentLifecycle.errors.previewPurge')); return; }
    setPreview(data); setTypedName(''); setPurgeConfirmed(false); setPurgeJob(null);
  };
  const openWorkstationChange = (agent: ManagedAgent) => {
    setWorkstationAgent(agent); setWorkstationPreview(null); setSmokeReceipt(null); setError('');
    const preferred = workers.find(worker => worker.deploymentId === 'production' && worker.status === 'healthy'
      && !worker.capabilities.includes('operator-plane')
      && worker.projectIds.includes(agent.id) && worker.workerId !== agent.workstation?.workerId);
    setTargetWorkerId(preferred?.workerId || '');
  };
  const previewWorkstationChange = async () => {
    if (!workstationAgent || !targetWorkerId) return;
    setWorkstationBusy(true); setError(''); setSmokeReceipt(null);
    try {
      const res = await fetch(`${API_BASE}/workbench-workers/projects/${workstationAgent.id}/workstation-change/preview`, {
        method: 'POST', headers: headers(), body: JSON.stringify({ deploymentId: 'production', targetWorkerId, authorityMode: 'project', reason: 'Admin Project Workstation change' }),
      });
      const data = await res.json(); if (!res.ok) throw new Error(data.message || data.error || t('agentLifecycle.errors.previewWorkstation'));
      setWorkstationPreview(data);
    } catch (err: any) { setError(err.message); } finally { setWorkstationBusy(false); }
  };
  const verifyWorkstationSmoke = async () => {
    if (!workstationAgent || !workstationPreview) return;
    setWorkstationBusy(true); setError('');
    try {
      const res = await fetch(`${API_BASE}/workbench-workers/projects/${workstationAgent.id}/workstation-change/smoke`, {
        method: 'POST', headers: headers(), body: JSON.stringify({ deploymentId: 'production', intentId: workstationPreview.intentId, proposalHash: workstationPreview.proposalHash }),
      });
      const data = await res.json(); if (!res.ok) throw new Error(data.message || data.error || t('agentLifecycle.errors.verifyWorkstation'));
      setSmokeReceipt(data);
    } catch (err: any) { setError(err.message); } finally { setWorkstationBusy(false); }
  };
  const applyWorkstationChange = async () => {
    if (!workstationAgent || !workstationPreview || !smokeReceipt) return;
    setWorkstationBusy(true); setError('');
    try {
      const res = await fetch(`${API_BASE}/workbench-workers/projects/${workstationAgent.id}/workstation-change/apply`, {
        method: 'POST', headers: headers(), body: JSON.stringify({ deploymentId: 'production', intentId: workstationPreview.intentId, proposalHash: workstationPreview.proposalHash, smokeReceiptHash: smokeReceipt.receiptHash, confirmed: true }),
      });
      const data = await res.json(); if (!res.ok) throw new Error(data.message || data.error || t('agentLifecycle.errors.applyWorkstation'));
      setWorkstationAgent(null); setWorkstationPreview(null); setSmokeReceipt(null); await refresh();
    } catch (err: any) { setError(err.message); } finally { setWorkstationBusy(false); }
  };
  const applyPurge = async () => {
    if (!preview) return;
    setError('');
    const res = await fetch(`${API_BASE}/admin/agents/${preview.impact.projectId}/purge/apply`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ intentId: preview.intentId, proposalHash: preview.proposalHash, typedName, confirmed: purgeConfirmed }),
    });
    const data = await res.json();
    if (!res.ok) { setError(data.error || t('agentLifecycle.errors.startPurge')); return; }
    setPurgeJob({ id: data.jobId, status: data.status });
  };
  return <div className="space-y-5">
    <div className="flex items-start justify-between gap-4">
      <div><h3 className="text-lg font-semibold text-surface-100">{t('agentManagement')}</h3><p className="text-sm text-surface-400 mt-1">{t('agentManagementIntro')}</p></div>
      <div className="flex rounded-lg border border-surface-700 p-1">
        {(['active', 'retired'] as const).map(key => <button key={key} onClick={() => setStatus(key)} className={`px-3 py-1.5 rounded-md text-sm ${status === key ? 'bg-primary-600/20 text-primary-700 dark:text-primary-200' : 'text-surface-400 hover:text-surface-100'}`}>{key === 'active' ? t('lifecycleActive') : t('lifecycleRetired')}</button>)}
      </div>
    </div>
    {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}
    {loading ? <div className="text-sm text-surface-400">{t('loadingAgents')}</div> : <div className="overflow-x-auto rounded-lg border border-surface-700">
      <table className="w-full text-sm">
        <thead className="bg-surface-800 text-surface-400"><tr><th className="p-3 text-left">{t('agent')}</th><th className="p-3 text-left">{t('owner')}</th><th className="p-3 text-right">{t('conversations')}</th><th className="p-3 text-right">{t('runtimeBoxTab')}</th><th className="p-3 text-left">{t('agentLifecycle.projectExecutionEnvironment')}</th><th className="p-3 text-right">{t('tasks')}</th></tr></thead>
        <tbody>{agents.map(agent => {
          const worker = workers.find(item => item.workerId === agent.workstation?.workerId);
          return <tr key={agent.id} className="border-t border-surface-800">
            <td className="p-3"><div className="font-medium text-surface-100">{agent.name}</div><div className="text-xs text-surface-500">{agent.lifecycleStatus}{agent.retiredAt ? ` · ${new Date(agent.retiredAt).toLocaleString()}` : ''}</div></td>
            <td className="p-3 text-surface-300">{agent.ownerUsername || t('systemOwner')}</td><td className="p-3 text-right text-surface-300">{agent.sessionCount}</td><td className="p-3 text-right text-surface-300">{agent.runtimeBoxCount}</td>
            <td className="p-3"><div className="text-xs font-medium text-surface-200">{agent.executionEnvironment ? t(`agentLifecycle.environmentModes.${agent.executionEnvironment.mode}`) : t('agentLifecycle.statusCheckRequired')}</div><div className="text-[11px] text-surface-500">{agent.executionEnvironment?.storageState && agent.executionEnvironment.storageState !== 'ready' ? t('agentLifecycle.statusCheckRequired') : agent.executionEnvironment?.mode === 'legacy-worker-workspace' ? `${agent.workstation?.workerId || t('agentLifecycle.statusCheckRequired')}${worker ? ` · ${worker.status}` : ''}` : null}</div></td>
            <td className="p-3 text-right">{status === 'active' && (agent.isMember ? <span className="mr-3 text-xs text-surface-400">{t('agentLifecycle.joined')}</span> : <button className="mr-3 text-xs text-primary-400" disabled={joiningId !== null} onClick={() => void joinAgent(agent)}>{joiningId === agent.id ? t('agentLifecycle.joining') : t('agentLifecycle.joinAction')}</button>)}{status === 'active' && agent.executionEnvironment?.mode === 'canonical-project-workspace' && <BrowserFileCanaryButton projectId={agent.id} name={agent.name} token={token} />}{status === 'retired' ? <button onClick={() => inspect(agent.id)} className="rounded-md border border-red-500/30 px-3 py-1.5 text-red-300 hover:bg-red-500/10">{t('permanentDeleteImpact')}</button> : <button onClick={() => openWorkstationChange(agent)} className="rounded-md border border-surface-600 px-3 py-1.5 text-surface-200 hover:border-primary-500/50 hover:bg-primary-500/10">{t('agentLifecycle.changePlan')}</button>}</td>
          </tr>;
        })}</tbody>
      </table>{agents.length === 0 && <div className="p-8 text-center text-sm text-surface-500">{t('noAgentsInStatus')}</div>}
    </div>}
    {workstationAgent && <div className="rounded-xl border border-primary-500/30 bg-surface-850 p-5 space-y-4">
      <div className="flex items-start justify-between gap-4"><div><h4 className="font-semibold text-surface-100">{t('agentLifecycle.workstationChangeTitle', { name: workstationAgent.name })}</h4><p className="mt-1 text-sm text-surface-400">{t('agentLifecycle.workstationChangeIntro')}</p></div><button onClick={() => setWorkstationAgent(null)} className="text-sm text-surface-500 hover:text-surface-200">{t('common:close')}</button></div>
      <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr]"><div className="rounded-lg border border-surface-700 p-3"><div className="text-xs text-surface-500">{t('agentLifecycle.current')}</div><div className="mt-1 font-mono text-sm text-surface-100">{workstationAgent.workstation?.enabled ? workstationAgent.workstation.workerId : 'Runtime Box'}</div></div><div className="hidden self-center text-surface-600 md:block">→</div><label className="rounded-lg border border-surface-700 p-3"><span className="text-xs text-surface-500">{t('agentLifecycle.target')}</span><select value={targetWorkerId} onChange={event => { setTargetWorkerId(event.target.value); setWorkstationPreview(null); setSmokeReceipt(null); }} className="mt-1 w-full bg-transparent text-sm text-surface-100 outline-none"><option value="">{t('agentLifecycle.selectWorker')}</option>{workers.filter(worker => worker.deploymentId === 'production' && !worker.capabilities.includes('operator-plane') && worker.workerId !== workstationAgent.workstation?.workerId).map(worker => <option key={worker.workerId} value={worker.workerId}>{worker.workerId} · {worker.status} · {worker.capacity.activeRuns}/{worker.capacity.maxRuns}</option>)}</select></label></div>
      {!workstationPreview ? <button disabled={!targetWorkerId || workstationBusy} onClick={previewWorkstationChange} className="rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">{t('agentLifecycle.createChangePlan')}</button> : <div className="space-y-3"><div className="grid grid-cols-2 gap-2 md:grid-cols-5">{Object.entries(workstationPreview.checks).map(([key, value]) => <div key={key} className="rounded-md border border-surface-700 px-3 py-2"><div className="text-[11px] text-surface-500">{key}</div><div className={`text-xs font-medium ${value === 'pass' ? 'text-emerald-300' : 'text-amber-300'}`}>{value}</div></div>)}</div><div className="text-xs text-surface-400">{t('agentLifecycle.previewSummary', { expires: new Date(workstationPreview.expiresAt).toLocaleString(), rollback: workstationPreview.impact.rollbackWorkerId || 'Runtime Box' })}</div>{!smokeReceipt ? <button disabled={workstationBusy} onClick={verifyWorkstationSmoke} className="tone-accent tone-action rounded-md px-4 py-2 text-sm font-medium disabled:opacity-40">{t('agentLifecycle.verifyTarget')}</button> : <div className="space-y-3"><div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3"><div className="text-sm font-medium text-emerald-200">{t('agentLifecycle.verificationPassed')}</div><div className="mt-1 text-xs text-emerald-300/80">{t('agentLifecycle.verificationDetails')}</div></div><button disabled={workstationBusy} onClick={applyWorkstationChange} className="rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">{t('agentLifecycle.applyVerifiedWorkstation')}</button></div>}</div>}
    </div>}
    {preview && <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-5 space-y-3"><div><h4 className="font-semibold text-surface-100">{preview.impact.projectName} · {t('permanentDeletionImpact')}</h4><p className="text-xs text-surface-500 mt-1">{t('previewExpires', { time: new Date(preview.expiresAt).toLocaleString() })} · {t('permanentDeletionWarning')}</p></div><div className="grid grid-cols-2 md:grid-cols-4 gap-3">{Object.entries(preview.impact.database).map(([key, value]) => <div key={key} className="rounded-lg bg-surface-900/60 p-3"><div className="text-xs text-surface-500">{key}</div><div className="text-lg font-semibold text-surface-100">{value}</div></div>)}</div><div className="text-sm text-surface-300">{t('agentLifecycle.credentialImpact', { dedicated: preview.impact.credentials.dedicated, shared: preview.impact.credentials.shared, reviewRequired: preview.impact.credentials.reviewRequired })}</div>{preview.impact.blockers.length > 0 ? <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">{t('agentLifecycle.blockers', { reasons: preview.impact.blockers.join(', ') })}</div> : <div className="space-y-3 border-t border-red-500/20 pt-3"><label className="block text-sm text-surface-300">{t('confirmAgentNamePrefix')} <strong className="text-surface-100">{preview.impact.projectName}</strong>{t('confirmAgentNameSuffix')}<input value={typedName} onChange={event => setTypedName(event.target.value)} className="mt-2 w-full rounded-lg border border-surface-700 bg-surface-900 px-3 py-2 text-surface-100" /></label><label className="flex items-start gap-2 text-sm text-surface-300"><input type="checkbox" checked={purgeConfirmed} onChange={event => setPurgeConfirmed(event.target.checked)} className="mt-1" /><span>{t('understandPermanentDeletion')}</span></label><button disabled={typedName !== preview.impact.projectName || !purgeConfirmed || !!purgeJob} onClick={applyPurge} className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">{t('startPermanentDeletion')}</button>{purgeJob && <div className="rounded-lg border border-primary-500/30 bg-primary-500/10 p-3 text-sm text-primary-700 dark:text-primary-200">{t('deletionProgress', { id: purgeJob.id, status: purgeJob.status })}</div>}</div>}</div>}
  </div>;
}

// ───── Users Tab ─────

// ───── Connections Tab ─────

type SharedConnection = {
  id: string;
  source: 'credential' | 'profile' | 'group';
  credentialId?: string;
  displayName: string;
  provider: string;
  connectionType: string;
  enabled: boolean;
  connectionScope?: 'shared' | 'agent_dedicated';
  status: 'connected' | 'needs_attention' | 'disabled' | 'off';
  readiness?: { providerHealth?: { status?: string } };
  stats: { connectedProjects: number };
};

type VmVaultCredential = {
  id: string;
  kind: string;
  provider: string;
  displayName: string;
  envName?: string | null;
  scope: 'workspace' | 'project';
  projectId?: string | null;
  projectName?: string | null;
  enabled: boolean;
  orphaned: boolean;
  updatedAt: string;
};

type VmVaultAuditEvent = {
  id: number;
  credentialId?: string | null;
  projectName?: string | null;
  eventType: string;
  actorUserId?: number | null;
  actorName?: string | null;
  provider?: string | null;
  status: 'ok' | 'error' | 'denied';
  message?: string | null;
  createdAt: string;
};

type GatewayCatalogEntry = {
  apiId: string;
  displayName: string;
  routePrefix: string;
  capability: string;
  enabled: boolean;
  costMeter: string;
  quotaMode: 'observe' | 'soft' | 'hard' | 'budget';
  readiness: 'ready' | 'degraded' | 'unverified' | 'disabled';
};

type GatewayProfile = {
  id: string;
  version: number;
  displayName: string;
  gatewayProvider: string;
  gatewayBaseUrl?: string | null;
  consumerRef?: string | null;
  stateMatches: boolean;
  status: 'pending' | 'ready' | 'degraded' | 'disabled';
  credential: { configured: boolean; enabled: boolean };
  lastVerifiedAt?: string | null;
  lastErrorCode?: string | null;
  catalog: GatewayCatalogEntry[];
};

type SharedConnectionDraft = {
  provider: string;
  displayName: string;
  envName: string;
  value: string;
};

const emptySharedConnectionDraft = (): SharedConnectionDraft => ({ provider: '', displayName: '', envName: '', value: '' });

function normalizeConnectionId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function normalizeConnectionEnv(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
}

/**
 * Kept as a no-op export while older App bundles still lazy-import it.
 * Personal Credential management has no user-facing surface anymore.
 */
export function PersonalCredentialsPanel(_props: PersonalCredentialsPanelProps) {
  return null;
}

function CredentialVaultManagement({ token }: { token?: string | null }) {
  const { t } = useTranslation('admin');
  const confirm = useConfirm();
  const role = getCurrentRole() || 'member';
  const canManage = role === 'admin';
  const [section, setSection] = useState<'shared' | 'agents' | 'audit'>('shared');
  const [connections, setConnections] = useState<SharedConnection[]>([]);
  const [gatewayProfiles, setGatewayProfiles] = useState<GatewayProfile[]>([]);
  const [gatewayLoadError, setGatewayLoadError] = useState('');
  const [agentCredentials, setAgentCredentials] = useState<VmVaultCredential[]>([]);
  const [auditEvents, setAuditEvents] = useState<VmVaultAuditEvent[]>([]);
  const [vaultSummary, setVaultSummary] = useState({ total: 0, workspace: 0, project: 0, orphaned: 0 });
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState<SharedConnectionDraft>(emptySharedConnectionDraft);
  const [replacement, setReplacement] = useState<{ connection: SharedConnection; value: string } | null>(null);
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  const headers = useCallback((): Record<string, string> => ({
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }), [token]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [overviewResponse, gatewayResponse] = await Promise.all([
        fetch(`${API_BASE}/credential-vault/admin-overview`, { headers: headers() }),
        fetch(`${API_BASE}/credential-vault/admin/gateway-profile`, { headers: headers() }),
      ]);
      const result = await overviewResponse.json().catch(() => ({}));
      const gatewayResult = await gatewayResponse.json().catch(() => ({}));
      if (!overviewResponse.ok) throw new Error(result.error || t('credentialConnections.loadFailed'));
      if (gatewayResponse.ok) {
        setGatewayProfiles(Array.isArray(gatewayResult.profiles) ? gatewayResult.profiles as GatewayProfile[] : []);
        setGatewayLoadError('');
      } else {
        setGatewayProfiles([]);
        setGatewayLoadError(t('credentialConnections.gateway.loadFailed'));
      }
      const inventory = Array.isArray(result.credentials) ? result.credentials as VmVaultCredential[] : [];
      setVaultSummary(result.summary ?? { total: inventory.length, workspace: 0, project: 0, orphaned: 0 });
      setAgentCredentials(inventory.filter(credential => credential.scope === 'project'));
      setAuditEvents(Array.isArray(result.audit) ? result.audit as VmVaultAuditEvent[] : []);
      setConnections(inventory.filter(credential => credential.scope === 'workspace').map(credential => ({
        id: `credential:${credential.id}`,
        source: 'credential',
        credentialId: credential.id,
        displayName: credential.displayName,
        provider: credential.provider,
        connectionType: credential.kind,
        enabled: credential.enabled,
        connectionScope: 'shared',
        status: credential.enabled ? 'connected' : 'disabled',
        readiness: {},
        stats: { connectedProjects: 0 },
      })));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('credentialConnections.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [headers, t]);

  useEffect(() => { void refresh(); }, [refresh]);

  const connectGoogle = async (credentialId?: string) => {
    if (!await confirm({
      title: t('credentialConnections.googleTitle'),
      message: t('credentialConnections.googleScopeNotice'),
      confirmLabel: t('credentialConnections.googleContinue'),
    })) return;
    setBusyId(credentialId || 'google');
    setError('');
    try {
      const params = new URLSearchParams({ mode: credentialId ? 'reauth' : 'create' });
      if (credentialId) params.set('credentialId', credentialId);
      const response = await fetch(`${API_BASE}/auth/google/organization?${params}`, { headers: headers() });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || typeof result.url !== 'string') throw new Error(result.error || t('credentialConnections.oauth.organizationGoogleStartFailed'));
      window.location.assign(result.url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('credentialConnections.oauth.organizationGoogleStartFailed'));
      setBusyId(null);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('oauth') !== 'google-organization') return;
    if (params.get('status') === 'success') {
      setStatusMessage(t('credentialConnections.oauth.organizationGoogleSaved'));
      void refresh();
    } else setError(t('credentialConnections.oauth.organizationGoogleSaveFailed'));
    for (const key of ['oauth', 'status', 'credentialId', 'message']) params.delete(key);
    const query = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  }, [refresh, t]);

  const addConnection = async () => {
    const provider = draft.provider.trim().toLowerCase();
    const displayName = draft.displayName.trim();
    const envName = normalizeConnectionEnv(draft.envName);
    const id = normalizeConnectionId(`${provider}-${envName}`);
    if (!provider || !displayName || !envName || !draft.value || !id) return;
    setBusyId('new');
    setError('');
    try {
      const response = await fetch(`${API_BASE}/credential-vault/credentials/api-key`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          id,
          provider,
          displayName,
          secretName: envName,
          secretValue: draft.value,
          defaultEnvName: envName,
          scope: 'workspace',
          metadata: { created_via: 'shared_connection_management' },
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || t('credentialConnections.saveFailed'));
      setDraft(emptySharedConnectionDraft());
      setShowAdd(false);
      setStatusMessage(t('credentialConnections.saved', { name: displayName }));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('credentialConnections.saveFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const setConnectionEnabled = async (connection: SharedConnection, enabled: boolean) => {
    if (!connection.credentialId) return;
    setBusyId(connection.id);
    setError('');
    try {
      const response = await fetch(`${API_BASE}/credential-vault/credentials/${encodeURIComponent(connection.credentialId)}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ enabled }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || t('credentialConnections.statusFailed'));
      setStatusMessage(t(enabled ? 'credentialConnections.enabled' : 'credentialConnections.disabledMessage', { name: connection.displayName }));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('credentialConnections.statusFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const replaceConnection = async () => {
    if (!replacement?.connection.credentialId || !replacement.value) return;
    setBusyId(replacement.connection.id);
    setError('');
    try {
      // Expected simplified backend contract: replace the encrypted value in one
      // immediate call while preserving the Connection id and Agent bindings.
      const response = await fetch(`${API_BASE}/credential-vault/credentials/${encodeURIComponent(replacement.connection.credentialId)}/rotate`, {
        method: 'POST', headers: headers(), body: JSON.stringify({ secretValue: replacement.value }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || t('credentialConnections.replaceFailed'));
      const name = replacement.connection.displayName;
      setReplacement(null);
      setStatusMessage(t('credentialConnections.replaced', { name }));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('credentialConnections.replaceFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const promoteCredential = async (credential: VmVaultCredential) => {
    if (!credential.projectId) return;
    const isGoogleOAuth = credential.provider === 'google' && credential.kind === 'gws';
    const approved = await confirm({
      title: t(isGoogleOAuth ? 'credentialConnections.promoteGoogleTitle' : 'credentialConnections.promoteTitle'),
      message: t(isGoogleOAuth ? 'credentialConnections.promoteGoogleConfirm' : 'credentialConnections.promoteConfirm', {
        name: credential.displayName,
        agent: credential.projectName || credential.projectId,
      }),
      confirmLabel: t('credentialConnections.promote'),
      danger: true,
    });
    if (!approved) return;
    setBusyId(`promote:${credential.id}`);
    setError('');
    try {
      const response = await fetch(`${API_BASE}/credential-vault/admin/credentials/${encodeURIComponent(credential.id)}/promote`, {
        method: 'POST', headers: headers(), body: JSON.stringify({ projectId: credential.projectId, confirmed: true }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || t('credentialConnections.promoteFailed'));
      setStatusMessage(t('credentialConnections.promoted', { name: credential.displayName }));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('credentialConnections.promoteFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const verifyGateway = async (profile: GatewayProfile) => {
    if (!await confirm({
      title: t('credentialConnections.gateway.verifyTitle'),
      message: t('credentialConnections.gateway.verifyDescription'),
      confirmLabel: t('credentialConnections.gateway.verifyAction'),
    })) return;
    setBusyId(`gateway:${profile.id}`);
    setError('');
    try {
      const response = await fetch(`${API_BASE}/credential-vault/admin/gateway-profile/verify`, {
        method: 'POST', headers: headers(), body: JSON.stringify({ confirmed: true, profileId: profile.id }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || t('credentialConnections.gateway.verifyFailed'));
      setStatusMessage(t(result.verified ? 'credentialConnections.gateway.verifyReady' : 'credentialConnections.gateway.verifyDegraded'));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('credentialConnections.gateway.verifyFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const updateGatewayApiPolicy = async (profile: GatewayProfile, api: GatewayCatalogEntry) => {
    const enabled = !api.enabled;
    if (!await confirm({
      title: t(enabled ? 'credentialConnections.gateway.allowTitle' : 'credentialConnections.gateway.denyTitle'),
      message: t(enabled ? 'credentialConnections.gateway.allowDescription' : 'credentialConnections.gateway.denyDescription', { name: api.displayName }),
      confirmLabel: t(enabled ? 'credentialConnections.gateway.allowAction' : 'credentialConnections.gateway.denyAction'),
    })) return;
    setBusyId(`gateway-policy:${profile.id}:${api.apiId}`);
    setError('');
    try {
      const response = await fetch(`${API_BASE}/credential-vault/admin/gateway-profile/catalog/${encodeURIComponent(api.apiId)}`, {
        method: 'PATCH', headers: headers(), body: JSON.stringify({ confirmed: true, profileId: profile.id, enabled }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || t('credentialConnections.gateway.policyFailed'));
      setStatusMessage(t(enabled ? 'credentialConnections.gateway.allowed' : 'credentialConnections.gateway.denied', { name: api.displayName }));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('credentialConnections.gateway.policyFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const deleteConnection = async (connection: SharedConnection) => {
    if (!connection.credentialId) return;
    const approved = await confirm({
      title: t('credentialConnections.deleteConfirmTitle'),
      message: t('credentialConnections.deleteConfirmMessage', { name: connection.displayName }),
      confirmLabel: t('credentialConnections.deletePermanently'),
      danger: true,
    });
    if (!approved) return;
    setBusyId(connection.id);
    setError('');
    try {
      // Expected simplified backend contract: remove one shared Connection and
      // its bindings. The UI intentionally exposes no target/profile/policy flow.
      const response = await fetch(`${API_BASE}/credential-vault/credentials/${encodeURIComponent(connection.credentialId)}`, {
        method: 'DELETE', headers: headers(),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || t('credentialConnections.deleteFailed'));
      setStatusMessage(t('credentialConnections.deleted', { name: connection.displayName }));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('credentialConnections.deleteFailed'));
    } finally {
      setBusyId(null);
    }
  };

  return <div className="space-y-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div><h3 className="text-xl font-semibold text-surface-100">{t('credentialConnections.vmVault')}</h3><p className="mt-1 max-w-2xl text-[14px] leading-6 text-surface-400">{t('credentialConnections.vmVaultDescription')}</p></div>
      <div className="flex gap-2"><button type="button" onClick={() => void refresh()} className="min-h-10 rounded-lg border border-surface-700 px-3 text-[13px] font-semibold text-surface-300 hover:bg-surface-800">{t('credentialConnections.actionLabels.refresh')}</button>{canManage && <button type="button" onClick={() => setShowAdd(value => !value)} className="min-h-10 rounded-lg bg-primary-600 px-3 text-[13px] font-semibold text-white hover:bg-primary-500">{showAdd ? t('credentialConnections.close') : t('credentialConnections.addConnection')}</button>}</div>
    </div>
    <nav aria-label={t('credentialConnections.vmVault')} className="flex flex-wrap gap-2">{(['shared', 'agents', 'audit'] as const).map(item => <button key={item} type="button" aria-pressed={section === item} onClick={() => setSection(item)} className={`tone-action min-h-10 rounded-lg px-3 text-[13px] ${section === item ? 'tone-accent' : 'tone-muted'}`}>{t(`credentialConnections.section_${item}`)}</button>)}</nav>
    <div hidden={section !== 'shared'}>
    {canManage && showAdd && <section className="flex flex-col gap-3 border-b border-surface-700 pb-4 sm:flex-row sm:items-center sm:justify-between">
      <div><h4 className="font-semibold text-surface-100">{t('credentialConnections.googleTitle')}</h4><p className="mt-1 text-[13px] leading-5 text-surface-400">{t('credentialConnections.googleScopeNotice')}</p></div>
      <button type="button" disabled={busyId !== null} onClick={() => void connectGoogle()} className="tone-action tone-accent min-h-10 shrink-0 rounded-lg px-3 text-[13px] font-semibold focus-visible:ring-2 focus-visible:ring-primary-400 disabled:opacity-50">{t('credentialConnections.googleConnect')}</button>
    </section>}
    {error && <div className="tone-card tone-danger rounded-lg p-3 text-[14px]">{error}</div>}
    {statusMessage && <div className="tone-card tone-success rounded-lg p-3 text-[14px]">{statusMessage}</div>}
    {gatewayProfiles.map(profile => {
      const profileTone = profile.status === 'ready' ? 'tone-success' : profile.status === 'degraded' ? 'tone-danger' : 'tone-muted';
      return <section key={profile.id} className="rounded-xl border border-surface-700 bg-surface-950/35 p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h4 className="text-[16px] font-semibold text-surface-100">{t('credentialConnections.gateway.title')}</h4><span className={`tone-pill px-2 py-1 text-[12px] ${profileTone}`}>{t(`credentialConnections.gateway.status_${profile.status}`)}</span></div><p className="mt-1 text-[13px] leading-5 text-surface-400">{t('credentialConnections.gateway.description')}</p></div>
          <button type="button" disabled={busyId !== null || !profile.credential.configured || !profile.credential.enabled || !profile.gatewayBaseUrl} onClick={() => void verifyGateway(profile)} className="tone-action tone-accent min-h-10 shrink-0 rounded-lg px-3 text-[13px] font-semibold disabled:cursor-not-allowed disabled:opacity-50">{busyId === `gateway:${profile.id}` ? t('credentialConnections.gateway.verifying') : t('credentialConnections.gateway.verifyAction')}</button>
        </div>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[[t('credentialConnections.gateway.profile'), `${profile.displayName} · v${profile.version}`], [t('credentialConnections.gateway.consumer'), profile.consumerRef || t('credentialConnections.gateway.notProvisioned')], [t('credentialConnections.gateway.credential'), t(profile.credential.configured && profile.credential.enabled ? 'credentialConnections.gateway.credentialReady' : 'credentialConnections.gateway.credentialMissing')], [t('credentialConnections.gateway.lastVerified'), profile.lastVerifiedAt ? new Date(profile.lastVerifiedAt).toLocaleString() : t('credentialConnections.gateway.neverVerified')]].map(([label, value]) => <div key={label} className="border-t border-surface-800 pt-2"><dt className="text-[11px] text-surface-500">{label}</dt><dd className="mt-1 truncate text-[13px] text-surface-200">{value}</dd></div>)}
        </dl>
        {profile.lastErrorCode && <div className="mt-3 rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2 font-mono text-[12px] text-red-300">{profile.lastErrorCode}</div>}
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[760px] text-left text-[12px]"><thead className="text-surface-500"><tr><th className="pb-2">{t('credentialConnections.gateway.api')}</th><th className="pb-2">{t('credentialConnections.gateway.capability')}</th><th className="pb-2">{t('credentialConnections.gateway.meter')}</th><th className="pb-2">{t('credentialConnections.gateway.quota')}</th><th className="pb-2">{t('credentialConnections.gateway.policy')}</th><th className="pb-2 text-right">{t('credentialConnections.gateway.readiness')}</th></tr></thead><tbody className="divide-y divide-surface-800">{profile.catalog.map(api => <tr key={api.apiId}><td className="py-2"><div className="font-medium text-surface-200">{api.displayName}</div><div className="font-mono text-[11px] text-surface-600">{api.routePrefix}</div></td><td className="py-2 text-surface-400">{api.capability}</td><td className="py-2 text-surface-400">{api.costMeter}</td><td className="py-2 text-surface-400">{api.quotaMode}</td><td className="py-2"><button type="button" disabled={busyId !== null} onClick={() => void updateGatewayApiPolicy(profile, api)} className={`tone-action min-h-8 rounded-md px-2 text-[11px] font-semibold disabled:opacity-50 ${api.enabled ? 'tone-success' : 'tone-muted'}`}>{t(api.enabled ? 'credentialConnections.gateway.policyAllowed' : 'credentialConnections.gateway.policyDenied')}</button></td><td className="py-2 text-right"><span className={`tone-pill px-2 py-1 ${api.readiness === 'ready' ? 'tone-success' : api.readiness === 'degraded' ? 'tone-danger' : 'tone-muted'}`}>{t(`credentialConnections.gateway.readiness_${api.readiness}`)}</span></td></tr>)}</tbody></table></div>
        <p className="mt-3 text-[11px] leading-4 text-surface-600">{t('credentialConnections.gateway.canaryNotice')}</p>
      </section>;
    })}
    {!loading && gatewayLoadError && <section className="tone-card tone-danger rounded-xl p-4 text-[13px]">{gatewayLoadError}</section>}
    {!loading && !gatewayLoadError && gatewayProfiles.length === 0 && <section className="rounded-xl border border-dashed border-surface-700 p-4 text-[13px] text-surface-500">{t('credentialConnections.gateway.empty')}</section>}
    <div className="grid gap-3 sm:grid-cols-4">
      {[['total', vaultSummary.total], ['workspace', vaultSummary.workspace], ['project', vaultSummary.project], ['orphaned', vaultSummary.orphaned]].map(([key, value]) => <div key={String(key)} className="rounded-xl border border-surface-700 bg-surface-950/35 p-3"><div className="text-[12px] text-surface-500">{t(`credentialConnections.summary.${key}`)}</div><div className="mt-1 text-2xl font-semibold text-surface-100">{value}</div></div>)}
    </div>
    {showAdd && canManage && <section className="grid gap-3 rounded-xl border border-primary-500/30 bg-surface-950/40 p-4 md:grid-cols-2">
      <label className="text-[13px] font-medium text-surface-400">{t('credentialConnections.provider')}<input value={draft.provider} onChange={event => setDraft(current => ({ ...current, provider: event.target.value }))} className="mt-1 min-h-11 w-full rounded-lg border border-surface-700 bg-surface-900 px-3 text-surface-100" /></label>
      <label className="text-[13px] font-medium text-surface-400">{t('credentialConnections.displayName')}<input value={draft.displayName} onChange={event => setDraft(current => ({ ...current, displayName: event.target.value }))} className="mt-1 min-h-11 w-full rounded-lg border border-surface-700 bg-surface-900 px-3 text-surface-100" /></label>
      <label className="text-[13px] font-medium text-surface-400">{t('credentialConnections.runtimeName')}<input value={draft.envName} onChange={event => setDraft(current => ({ ...current, envName: event.target.value }))} className="mt-1 min-h-11 w-full rounded-lg border border-surface-700 bg-surface-900 px-3 font-mono text-surface-100" /></label>
      <label className="text-[13px] font-medium text-surface-400">{t('credentialConnections.secretValue')}<input type="password" autoComplete="off" value={draft.value} onChange={event => setDraft(current => ({ ...current, value: event.target.value }))} className="mt-1 min-h-11 w-full rounded-lg border border-surface-700 bg-surface-900 px-3 font-mono text-surface-100" /></label>
      <button type="button" disabled={busyId !== null || !draft.provider.trim() || !draft.displayName.trim() || !normalizeConnectionEnv(draft.envName) || !draft.value} onClick={() => void addConnection()} className="min-h-11 rounded-lg bg-primary-600 px-4 text-[14px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 md:col-span-2">{busyId === 'new' ? t('credentialConnections.saving') : t('credentialConnections.addConnection')}</button>
    </section>}
    {loading ? <div className="py-8 text-center text-[14px] text-surface-500">{t('credentialConnections.connectionsLoading')}</div> : <div className="overflow-hidden rounded-xl border border-surface-700 bg-surface-950/25">
      {connections.length === 0 && <div className="p-8 text-center text-[14px] text-surface-500">{t('credentialConnections.emptyTeamConnections')}</div>}
      {connections.map(connection => {
        const active = connection.enabled && connection.status !== 'disabled';
        const isGoogle = connection.provider === 'google' && connection.connectionType === 'gws';
        return <div key={connection.id} className="border-b border-surface-800 last:border-b-0">
          <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
            <div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-2"><h4 className="truncate text-[14px] font-semibold text-surface-100">{connection.displayName}</h4><span className={`tone-pill shrink-0 px-2 py-0.5 text-[11px] ${active ? 'tone-success' : 'tone-muted'}`}>{active ? t('credentialConnections.storedActive') : t('credentialConnections.disabled')}</span></div><p className="mt-1 truncate text-[12px] text-surface-500">{connection.provider} · {connection.connectionType}</p></div>
            <div className="flex flex-wrap gap-2 sm:shrink-0">
              {canManage && <><button type="button" disabled={busyId !== null} onClick={() => isGoogle ? void connectGoogle(connection.credentialId) : setReplacement({ connection, value: '' })} className="min-h-9 rounded-lg border border-surface-700 px-3 text-[12px] font-semibold text-surface-200 hover:bg-surface-800">{t(isGoogle ? 'credentialConnections.reauthenticateOrg' : 'credentialConnections.replace')}</button><button type="button" disabled={busyId !== null} onClick={() => void setConnectionEnabled(connection, !active)} className="min-h-9 rounded-lg border border-surface-700 px-3 text-[12px] font-semibold text-surface-200 hover:bg-surface-800">{active ? t('credentialConnections.disable') : t('credentialConnections.enable')}</button><button type="button" disabled={busyId !== null} onClick={() => void deleteConnection(connection)} className="tone-action tone-danger min-h-9 rounded-lg px-3 text-[12px] font-semibold">{t('credentialConnections.delete')}</button></>}
            </div>
          </div>
          {replacement?.connection.id === connection.id && <div className="border-t border-primary-500/20 bg-surface-900/60 px-4 py-3"><div className="flex flex-col gap-3 sm:flex-row sm:items-end"><label className="flex-1 text-[12px] font-medium text-surface-300">{t('credentialConnections.newSecretValue')}<input type="password" autoComplete="off" value={replacement.value} onChange={event => setReplacement(current => current ? { ...current, value: event.target.value } : null)} className="mt-1 min-h-10 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 font-mono text-[13px] text-surface-100" /></label><div className="flex gap-2"><button type="button" disabled={!replacement.value || busyId !== null} onClick={() => void replaceConnection()} className="min-h-10 rounded-lg bg-primary-600 px-3 text-[12px] font-semibold text-white disabled:opacity-50">{t('credentialConnections.replace')}</button><button type="button" onClick={() => setReplacement(null)} className="min-h-10 rounded-lg border border-surface-700 px-3 text-[12px] font-semibold text-surface-300">{t('common:cancel')}</button></div></div></div>}
        </div>;
      })}
    </div>}
    </div>
    <div hidden={section !== 'agents'}>
    <section className="rounded-xl border border-surface-700 bg-surface-950/25 p-4">
      <div className="mb-3"><h4 className="text-[16px] font-semibold text-surface-100">{t('credentialConnections.agentCredentials')}</h4><p className="mt-1 text-[13px] text-surface-500">{t('credentialConnections.agentCredentialsDescription')}</p></div>
      <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-[13px]"><thead className="text-surface-500"><tr><th className="pb-2">{t('credentialConnections.displayName')}</th><th className="pb-2">{t('credentialConnections.provider')}</th><th className="pb-2">{t('credentialConnections.agent')}</th><th className="pb-2">{t('credentialConnections.status')}</th><th className="pb-2 text-right">{t('credentialConnections.actions')}</th></tr></thead><tbody className="divide-y divide-surface-800">{agentCredentials.map(credential => <tr key={credential.id}><td className="py-3"><div className="font-medium text-surface-200">{credential.displayName}</div><div className="font-mono text-[11px] text-surface-600">{credential.id}</div></td><td className="py-3 text-surface-400">{credential.provider} · {credential.kind}</td><td className="py-3 text-surface-400">{credential.projectName || credential.projectId || t('credentialConnections.unknownAgent')}</td><td className="py-3"><span className={`tone-pill px-2 py-1 ${credential.orphaned ? 'tone-danger' : credential.enabled ? 'tone-success' : 'tone-muted'}`}>{credential.orphaned ? t('credentialConnections.orphaned') : credential.enabled ? t('credentialConnections.storedActive') : t('credentialConnections.disabled')}</span></td><td className="py-3 text-right">{canManage && !credential.orphaned && <button type="button" disabled={busyId !== null} onClick={() => void promoteCredential(credential)} className="min-h-9 rounded-lg border border-primary-500/40 px-3 text-[12px] font-semibold text-primary-300 hover:bg-primary-500/10 disabled:opacity-50">{busyId === `promote:${credential.id}` ? t('credentialConnections.promoting') : t('credentialConnections.promote')}</button>}</td></tr>)}</tbody></table></div>
      {agentCredentials.length === 0 && <div className="py-6 text-center text-[13px] text-surface-500">{t('credentialConnections.emptyAgentCredentials')}</div>}
    </section>
    </div>
    <div hidden={section !== 'audit'}>
    <section className="rounded-xl border border-surface-700 bg-surface-950/25 p-4">
      <div className="mb-3"><h4 className="text-[16px] font-semibold text-surface-100">{t('credentialConnections.auditTitle')}</h4><p className="mt-1 text-[13px] text-surface-500">{t('credentialConnections.auditDescription')}</p></div>
      <div className="max-h-80 overflow-auto"><table className="w-full min-w-[760px] text-left text-[12px]"><thead className="sticky top-0 bg-surface-950 text-surface-500"><tr><th className="pb-2">{t('credentialConnections.time')}</th><th className="pb-2">{t('credentialConnections.event')}</th><th className="pb-2">{t('credentialConnections.credential')}</th><th className="pb-2">{t('credentialConnections.actor')}</th><th className="pb-2">{t('credentialConnections.status')}</th></tr></thead><tbody className="divide-y divide-surface-800">{auditEvents.map(event => <tr key={event.id}><td className="py-2 pr-3 whitespace-nowrap text-surface-500">{new Date(event.createdAt).toLocaleString()}</td><td className="py-2 pr-3 text-surface-300">{event.eventType}</td><td className="py-2 pr-3"><div className="text-surface-300">{event.credentialId || '-'}</div><div className="text-surface-600">{event.projectName || event.provider || ''}</div></td><td className="py-2 pr-3 text-surface-400">{event.actorName || event.actorUserId || '-'}</td><td className="py-2"><span className={`tone-pill px-2 py-1 ${event.status === 'ok' ? 'tone-success' : 'tone-danger'}`}>{event.status}</span></td></tr>)}</tbody></table></div>
      {auditEvents.length === 0 && <div className="py-6 text-center text-[13px] text-surface-500">{t('credentialConnections.emptyAudit')}</div>}
    </section>
    </div>
  </div>;
}

// ───── System Tab ─────

function SystemInfo() {
  const { t } = useTranslation('admin');
  const role = getCurrentRole() || 'member';
  const isAdmin = role === 'admin';
  const [defaultResponseLanguage, setDefaultResponseLanguage] = useState<'en' | 'ko'>('ko');
  const [languageSaving, setLanguageSaving] = useState(false);
  const serverConfig = useSettingsStore((s) => s.serverConfig);
  const updateAvailable = useSettingsStore((s) => s.updateAvailable);
  const latestBuildId = useSettingsStore((s) => s.latestBuildId);
  const [apiHealth, setApiHealth] = useState<any | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(() => {
    fetch('/api/health')
      .then(r => r.json())
      .then(setApiHealth)
      .catch((err) => setApiHealth({ status: 'error', error: String(err) }));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!isAdmin) return;
    fetch(`${API_BASE}/admin/language-settings`)
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (data?.defaultResponseLanguage === 'en' || data?.defaultResponseLanguage === 'ko') {
          setDefaultResponseLanguage(data.defaultResponseLanguage);
        }
      })
      .catch(() => {});
  }, [isAdmin]);

  const saveDefaultResponseLanguage = async (language: 'en' | 'ko') => {
    setDefaultResponseLanguage(language);
    setLanguageSaving(true);
    try {
      const response = await fetch(`${API_BASE}/admin/language-settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultResponseLanguage: language }),
      });
      if (response.ok) {
        const data = await response.json();
        setDefaultResponseLanguage(data.defaultResponseLanguage);
      }
    } finally {
      setLanguageSaving(false);
    }
  };

  const defaults = serverConfig?.defaults || {};
  const publicUrl = serverConfig?.publicUrl || apiHealth?.publicUrl || window.location.origin;
  const gitSha = serverConfig?.gitSha || apiHealth?.gitSha;
  const version = serverConfig?.version || apiHealth?.version || '-';
  const buildTime = serverConfig?.buildTime || apiHealth?.buildTime || '-';
  const buildId = serverConfig?.buildId || apiHealth?.buildId || '-';
  const apiOk = apiHealth?.status === 'ok';
  const configRows = [
    { label: t('version'), value: `v${version}${gitSha ? ` · ${String(gitSha).slice(0, 7)}` : ''}`, mono: true },
    { label: t('buildTime'), value: buildTime, mono: true },
    { label: t('buildId'), value: buildId, mono: true },
    { label: t('publicUrl'), value: publicUrl, mono: true },
    { label: t('serverRole'), value: serverConfig?.towerRole || '-', mono: true },
    { label: t('nodeEnv'), value: serverConfig?.nodeEnv || '-', mono: true },
    { label: t('workspace'), value: serverConfig?.workspaceRoot || '-', mono: true },
    { label: t('permissionMode'), value: serverConfig?.permissionMode || '-', mono: true },
    { label: t('claudeExecutable'), value: serverConfig?.claudeExecutable || '-', mono: true },
  ];
  const modelRows = [
    { label: t('sessionModel'), value: defaults.session || '-' },
    { label: t('aiReplyModel'), value: defaults.ai_reply || '-' },
    { label: t('taskExecutionModel'), value: defaults.session || '-' },
  ];

  const copyDiagnostics = async () => {
    const payload = {
      apiHealth,
      browserTool: {
        deprecated: true,
        replacement: 'Runtime Box Playwright/system Chromium',
      },
      serverConfig: {
        version,
        gitSha,
        buildTime,
        buildId,
        publicUrl,
        towerRole: serverConfig?.towerRole,
        nodeEnv: serverConfig?.nodeEnv,
        workspaceRoot: serverConfig?.workspaceRoot,
        permissionMode: serverConfig?.permissionMode,
        claudeExecutable: serverConfig?.claudeExecutable,
        defaults,
        updateAvailable,
        latestBuildId,
      },
      capturedAt: new Date().toISOString(),
    };
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold text-gray-300 uppercase tracking-wider">{t('systemDiagnostics')}</h3>
          <p className="text-[13px] text-gray-600 mt-1">{t('systemDiagnosticsIntro')}</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button onClick={refresh} className="px-3 py-1.5 text-[13px] rounded-md border border-surface-700 text-gray-400 hover:text-gray-200 hover:bg-surface-800 transition-colors">
            {t('refresh')}
          </button>
          <button onClick={copyDiagnostics} className="px-3 py-1.5 text-[13px] rounded-md bg-primary-600/20 border border-primary-500/30 text-primary-300 hover:bg-primary-600/30 transition-colors">
            {copied ? t('copied') : t('copyDiagnostics')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <HealthCard label={t('apiStatus')} ok={apiOk} detail={apiOk ? t('healthy') : (apiHealth?.error || t('notConnected'))} />
        <HealthCard label={t('updateStatus')} ok={!updateAvailable} detail={updateAvailable ? t('updateAvailableDetail', { buildId: latestBuildId || '-' }) : t('upToDate')} />
      </div>

      {isAdmin && (
        <div className="rounded-lg border border-surface-700 bg-surface-900/40 p-4 space-y-3">
          <div>
            <h3 className="text-[14px] font-semibold text-gray-300">{i18n.language === 'ko' ? '기본 AI 응답 언어' : 'Default AI response language'}</h3>
            <p className="mt-1 text-[13px] text-gray-500">{i18n.language === 'ko' ? '개인 설정이 없는 사용자의 기본값입니다. 개인 설정과 현재 요청이 우선합니다.' : 'Used when a user has no personal preference. Personal settings and explicit requests take precedence.'}</p>
          </div>
          <select
            value={defaultResponseLanguage}
            disabled={languageSaving}
            onChange={event => saveDefaultResponseLanguage(event.target.value as 'en' | 'ko')}
            className="w-full max-w-xs rounded-lg border border-surface-700 bg-surface-900 px-3 py-2 text-sm text-surface-200"
          >
            <option value="en">English</option>
            <option value="ko">한국어</option>
          </select>
        </div>
      )}

      <div className="rounded-lg border border-surface-700 divide-y divide-surface-800/50">
        {configRows.map((row) => <InfoRow key={row.label} label={row.label} value={row.value} mono={row.mono} />)}
      </div>

      <div>
        <h3 className="text-[14px] font-semibold text-gray-500 uppercase tracking-wider mb-3">{t('defaultModels')}</h3>
        <div className="rounded-lg border border-surface-700 divide-y divide-surface-800/50">
          {modelRows.map((row) => <InfoRow key={row.label} label={row.label} value={row.value} mono />)}
        </div>
      </div>
    </div>
  );
}

function HealthCard({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="rounded-lg border border-surface-700 bg-surface-800/30 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${ok ? 'tone-success tone-bg' : 'tone-warning tone-bg'}`} />
        <span className="text-[14px] font-semibold text-gray-300">{label}</span>
      </div>
      <p className="mt-1 text-[13px] text-gray-500 truncate" title={detail}>{detail}</p>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <span className="text-[15px] text-gray-400 shrink-0">{label}</span>
      <span className={`text-[15px] text-gray-200 ${mono ? 'font-mono' : ''} min-w-0 max-w-[680px] truncate text-right`} title={value}>
        {value}
      </span>
    </div>
  );
}
