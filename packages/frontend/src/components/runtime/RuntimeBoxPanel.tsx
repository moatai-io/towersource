import React from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { toastSuccess } from '../../utils/toast';
import { emitProductNotice } from '../../utils/product-notice';
import { useConfirm } from '../../hooks/useDialog';
import { getCurrentRole } from '../../utils/auth';

type RuntimeBox = {
  id: number;
  project_id: string;
  project_name?: string | null;
  status: string;
  runtime_profile?: string | null;
  project_root?: string | null;
  memory_mb?: number | null;
  cpu_limit?: number | string | null;
  idle_stop_minutes?: number | null;
  last_active_at?: string | null;
  started_at?: string | null;
  stopped_at?: string | null;
  updated_at?: string | null;
  last_error?: string | null;
};

type RuntimeService = {
  id: number;
  box_id: number;
  project_id: string;
  name: string;
  display_name?: string | null;
  command: string;
  cwd?: string | null;
  internal_port?: number | null;
  external_url?: string | null;
  status: string;
  process_pid?: number | null;
  log_path?: string | null;
  pinned?: boolean | null;
  purpose?: string | null;
  ttl_hours?: number | null;
  expires_at?: string | null;
  last_active_at?: string | null;
  created_at?: string | null;
  last_error?: string | null;
  project_name?: string | null;
  box_status?: string | null;
  runtime_profile?: string | null;
};

type ServicesResponse = {
  boxes?: RuntimeBox[];
  services: RuntimeService[];
  summary?: string;
};

type EnvironmentOverview = {
  deploymentId: string;
  projects: { projectId: string; name: string; storageKind: string; storageState: string; environmentMode: string; preferredWorkerId: string | null }[];
  workers: { workerId: string; status: string; draining: boolean; activeRuns: number; maxRuns: number }[];
};

type CapacityResponse = {
  host: { cpuThreads: number; totalMemoryMb: number };
  box: { maxMemoryMb: number };
  recommended: { maxRunning: number; maxRunningPerUser: number };
  current: { maxRunning: number; maxRunningPerUser: number };
};

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function fmtDate(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function badgeClass(status: string): string {
  switch (status) {
    case 'running': return 'tone-success';
    case 'starting':
    case 'pending': return 'tone-warning';
    case 'error': return 'tone-danger';
    case 'expired': return 'tone-info';
    case 'idle_stopped':
    case 'stopped': return 'tone-muted';
    default: return 'tone-muted';
  }
}

function parseCommand(raw: string): { clean: string; envCount: number; hiddenEnvKeys: string[] } {
  const tokens = raw.match(/(?:[^\s'\"]+|'[^']*'|\"[^\"]*\")+/g) || [];
  let idx = 0;
  const keys: string[] = [];
  for (; idx < tokens.length; idx++) {
    const token = tokens[idx];
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) break;
    keys.push(token.slice(0, token.indexOf('=')));
  }
  const clean = tokens.slice(idx).join(' ') || raw;
  return { clean, envCount: keys.length, hiddenEnvKeys: keys };
}

function projectLabel(item: { project_name?: string | null; project_id: string }) {
  return item.project_name || item.project_id.slice(0, 8);
}

export function runtimeBoxErrorPresentation(box: RuntimeBox): { label: string; className: string } | null {
  if (!box.last_error) return null;
  if (box.status === 'error') {
    return { label: box.last_error, className: 'text-red-300' };
  }
  return { label: i18n.t('runtimeBox.recoveredError', { ns: 'common', error: box.last_error }), className: 'text-surface-500' };
}

export function RuntimeBoxPanel() {
  const { t } = useTranslation('common');
  const confirm = useConfirm();
  const canEditCapacity = getCurrentRole() === 'admin';
  const [data, setData] = React.useState<ServicesResponse | null>(null);
  const [environment, setEnvironment] = React.useState<EnvironmentOverview | null>(null);
  const [environmentError, setEnvironmentError] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [logs, setLogs] = React.useState<{ service: RuntimeService; text: string } | null>(null);
  const [logsLoading, setLogsLoading] = React.useState<number | null>(null);
  const [stoppingServiceId, setStoppingServiceId] = React.useState<number | null>(null);
  const [busyBoxId, setBusyBoxId] = React.useState<number | null>(null);
  const [capacity, setCapacity] = React.useState<CapacityResponse | null>(null);
  const [capacityDraft, setCapacityDraft] = React.useState({ maxRunning: 8, maxRunningPerUser: 5 });
  const [capacitySaving, setCapacitySaving] = React.useState(false);

  const boxes = data?.boxes || [];
  const runningBoxes = boxes.filter((b) => b.status === 'running' || b.status === 'starting').length;
  const services = data?.services || [];

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const overviewRes = await fetch('/api/runtime-box/environment-overview', { headers: authHeaders() });
      if (overviewRes.ok) { setEnvironment(await overviewRes.json()); setEnvironmentError(false); }
      else { setEnvironment(null); setEnvironmentError(true); }
      const res = await fetch('/api/runtime-box/services?status=running,pending,error,expired', {
        headers: authHeaders(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setData(body);
      const capacityRes = await fetch('/api/runtime-box/capacity', { headers: authHeaders() });
      const capacityBody = await capacityRes.json().catch(() => ({}));
      if (!capacityRes.ok) throw new Error(capacityBody.error || `Capacity HTTP ${capacityRes.status}`);
      setCapacity(capacityBody);
      setCapacityDraft(capacityBody.current);
    } catch (err: unknown) {
      emitProductNotice({ code: 'runtime.load.failed', technicalDetail: err });
      setData(null);
      setEnvironment(null);
      setEnvironmentError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const saveCapacity = async () => {
    const exceedsRecommendation = !!capacity && (
      capacityDraft.maxRunning > capacity.recommended.maxRunning ||
      capacityDraft.maxRunningPerUser > capacity.recommended.maxRunningPerUser
    );
    if (exceedsRecommendation) {
      const ok = await confirm({
        title: t('runtimeBox.capacity.exceedsTitle'),
        message: t('runtimeBox.capacity.exceedsMessage'),
        confirmLabel: t('runtimeBox.capacity.applyExceeded'),
        danger: true,
      });
      if (!ok) return;
    }
    setCapacitySaving(true);
    try {
      const res = await fetch('/api/runtime-box/capacity', {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(capacityDraft),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setCapacity(body);
      setCapacityDraft(body.current);
      toastSuccess(t('runtimeBox.capacity.applied'));
    } catch (err: unknown) {
      emitProductNotice({ code: 'runtime.capacity.save.failed', technicalDetail: err });
    } finally {
      setCapacitySaving(false);
    }
  };

  const openLogs = async (service: RuntimeService) => {
    setLogsLoading(service.id);
    try {
      const res = await fetch(`/api/runtime-box/services/${service.id}/logs?tail=300`, { headers: authHeaders() });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setLogs({ service, text: body.text || '' });
    } catch (err: unknown) {
      emitProductNotice({
        code: 'runtime.logs.load.failed',
        context: { serviceId: service.id },
        technicalDetail: err,
      });
    } finally {
      setLogsLoading(null);
    }
  };

  const stopService = async (service: RuntimeService) => {
    setStoppingServiceId(service.id);
    try {
      const res = await fetch(`/api/runtime-box/services/${service.id}/stop`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      toastSuccess(`Stopped ${service.name}`);
      await load();
    } catch (err: unknown) {
      emitProductNotice({
        code: 'runtime.service.stop.failed',
        context: { serviceId: service.id },
        technicalDetail: err,
      });
    } finally {
      setStoppingServiceId(null);
    }
  };

  const stopBox = async (box: RuntimeBox) => {
    const ok = await confirm({
      title: t('runtimeBox.stop.title'),
      message: t('runtimeBox.stop.message', { project: projectLabel(box) }),
      confirmLabel: t('runtimeBox.stop.confirm'),
      danger: true,
    });
    if (!ok) return;
    setBusyBoxId(box.id);
    try {
      const res = await fetch(`/api/runtime-box/boxes/${box.id}/stop`, { method: 'POST', headers: authHeaders() });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      toastSuccess(t('runtimeBox.stop.completed', { id: box.id }));
      await load();
    } catch (err: unknown) {
      emitProductNotice({
        code: 'runtime.box.stop.failed',
        context: { boxId: box.id },
        technicalDetail: err,
      });
    } finally {
      setBusyBoxId(null);
    }
  };

  const destroyBox = async (box: RuntimeBox) => {
    const ok = await confirm({
      title: t('runtimeBox.cleanup.title'),
      message: t('runtimeBox.cleanup.message', { project: projectLabel(box) }),
      confirmLabel: t('runtimeBox.cleanup.confirm'),
      danger: true,
    });
    if (!ok) return;
    setBusyBoxId(box.id);
    try {
      const res = await fetch(`/api/runtime-box/boxes/${box.id}`, { method: 'DELETE', headers: authHeaders() });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      toastSuccess(t('runtimeBox.cleanup.completed', { id: box.id }));
      await load();
    } catch (err: unknown) {
      emitProductNotice({
        code: 'runtime.box.cleanup.failed',
        context: { boxId: box.id },
        technicalDetail: err,
      });
    } finally {
      setBusyBoxId(null);
    }
  };

  return (
    <div className="relative z-10 h-full overflow-auto bg-surface-950 text-gray-100">
      <div className="mx-auto max-w-6xl p-6 space-y-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="text-sm uppercase tracking-[0.24em] text-primary-400/80">{t('runtimeBox.legacyEyebrow')}</div>
            <h1 className="mt-1 text-3xl font-semibold text-gray-100">{t('runtimeBox.legacyTitle')}</h1>
            <p className="mt-1 text-base text-surface-400">{t('runtimeBox.description')}</p>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-amber-200">{t('runtimeBox.legacyScope')}</p>
          </div>
          <button onClick={load} disabled={loading} className="rounded-lg border border-surface-700 bg-surface-850 px-3 py-2 text-base text-surface-200 hover:bg-surface-800 disabled:opacity-50">
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <section className="rounded-xl border border-surface-800 bg-surface-900/70 p-4 space-y-3">
          <h2 className="text-lg font-semibold text-surface-100">{t('runtimeBox.environment.title')}</h2>
          <p className="text-sm text-surface-400">{t('runtimeBox.environment.description')}</p>
          {environmentError && <p role="alert" className="text-sm text-amber-200">{t('runtimeBox.environment.unavailable')}</p>}
          {environment && <>
            <p className="text-xs text-surface-500">{t('runtimeBox.environment.deployment', { id: environment.deploymentId })}</p>
            <div className="grid gap-2 md:grid-cols-2">
              {environment.workers.map(worker => <div key={worker.workerId} className="rounded-lg border border-surface-700 p-3 text-sm">
                <strong>{worker.workerId}</strong> · {worker.status}{worker.draining ? ` · ${t('runtimeBox.environment.draining')}` : ''}
                <div className="text-surface-400">{t('runtimeBox.environment.workerRuns', { active: worker.activeRuns, max: worker.maxRuns })}</div>
              </div>)}
              {environment.workers.length === 0 && <p className="text-sm text-surface-500">{t('runtimeBox.environment.noWorkers')}</p>}
            </div>
            <div className="max-h-72 overflow-auto divide-y divide-surface-800">
              {environment.projects.map(project => <div key={project.projectId} className="flex flex-wrap justify-between gap-2 py-2 text-sm">
                <span>{project.name}</span><span className="text-surface-400">{project.environmentMode} · {project.storageKind}/{project.storageState}{project.preferredWorkerId ? ` · ${project.preferredWorkerId}` : ''}</span>
              </div>)}
              {environment.projects.length === 0 && <p className="py-2 text-sm text-surface-500">{t('runtimeBox.environment.noProjects')}</p>}
            </div>
          </>}
        </section>

        <div className="grid gap-3 md:grid-cols-3">
          <Stat label={t('runtimeBox.boxCount')} value={boxes.length} />
          <Stat label={t('runtimeBox.runningCount')} value={runningBoxes} />
          <Stat label={t('runtimeBox.serviceCount')} value={services.length} />
        </div>

        {capacity && <section className="rounded-xl border border-surface-800 bg-surface-900/70 p-4 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-surface-100">{t('runtimeBox.capacity.title')}</h2>
            <p className="mt-1 text-sm text-surface-400">{t('runtimeBox.capacity.host', { cpu: capacity.host.cpuThreads, ram: (capacity.host.totalMemoryMb / 1024).toFixed(1), max: (capacity.box.maxMemoryMb / 1024).toFixed(1) })}</p>
            <p className="mt-1 text-sm text-surface-500">{t('runtimeBox.capacity.description')}</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-sm text-surface-300">
              <span>{t('runtimeBox.capacity.serverLimit', { count: capacity.recommended.maxRunning })}</span>
              <input type="number" min={1} value={capacityDraft.maxRunning} onChange={(e) => setCapacityDraft((v) => ({ ...v, maxRunning: Number(e.target.value) }))} className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-surface-100" />
            </label>
            <label className="space-y-1 text-sm text-surface-300">
              <span>{t('runtimeBox.capacity.userLimit', { count: capacity.recommended.maxRunningPerUser })}</span>
              <input type="number" min={1} value={capacityDraft.maxRunningPerUser} onChange={(e) => setCapacityDraft((v) => ({ ...v, maxRunningPerUser: Number(e.target.value) }))} className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-surface-100" />
            </label>
          </div>
          {(capacityDraft.maxRunning > capacity.recommended.maxRunning || capacityDraft.maxRunningPerUser > capacity.recommended.maxRunningPerUser) && <div className="tone-card tone-warning rounded-lg p-3 text-sm">{t('runtimeBox.capacity.exceededWarning')}</div>}
          {capacityDraft.maxRunningPerUser > capacityDraft.maxRunning && <div className="text-sm text-surface-500">{t('runtimeBox.capacity.userOverServer')}</div>}
          {canEditCapacity ? <div className="flex justify-end"><button onClick={saveCapacity} disabled={capacitySaving || capacityDraft.maxRunning < 1 || capacityDraft.maxRunningPerUser < 1} className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-500 disabled:opacity-50">{capacitySaving ? t('runtimeBox.capacity.saving') : t('runtimeBox.capacity.save')}</button></div> : <p className="text-sm text-surface-500">{t('runtimeBox.capacity.adminOnly')}</p>}
        </section>}

        <section className="overflow-hidden rounded-xl border border-surface-800 bg-surface-900/70">
          <div className="border-b border-surface-800 px-4 py-3 text-base font-semibold text-surface-200">{t('runtimeBox.boxList')}</div>
          {boxes.length === 0 ? (
            <div className="p-8 text-center text-base text-surface-500">{loading ? t('runtimeBox.loadingBoxes') : t('runtimeBox.noBoxes')}</div>
          ) : (
            <div className="divide-y divide-surface-800">
              {boxes.map((b) => {
                const errorPresentation = runtimeBoxErrorPresentation(b);
                return (
                  <div key={b.id} className="p-4">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-gray-100">#{b.id} {projectLabel(b)}</span>
                          <span className={`tone-pill px-2 py-0.5 text-sm ${badgeClass(b.status)}`}>{b.status}</span>
                          {b.runtime_profile && <span className="rounded-full border border-surface-700 px-2 py-0.5 text-sm text-surface-400">{b.runtime_profile}</span>}
                        </div>
                        <div className="truncate font-mono text-sm text-surface-400">{b.project_root || b.project_id}</div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-surface-500">
                          <span>Last active {fmtDate(b.last_active_at)}</span>
                          <span>Idle stop {b.idle_stop_minutes ?? '—'}m</span>
                          {b.memory_mb && <span>{b.memory_mb}MB</span>}
                          {errorPresentation && <span className={errorPresentation.className}>{errorPresentation.label}</span>}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        {(b.status === 'running' || b.status === 'starting') && (
                          <button onClick={() => stopBox(b)} disabled={busyBoxId === b.id} className="rounded-lg border border-red-500/40 px-3 py-1.5 text-sm font-semibold text-red-300 hover:bg-red-500/10 disabled:opacity-50">
                            {busyBoxId === b.id ? t('runtimeBox.stop.stopping') : t('runtimeBox.stop.confirm')}
                          </button>
                        )}
                        {b.status !== 'running' && b.status !== 'starting' && (
                          <div className="flex flex-col items-start gap-1">
                            <button onClick={() => destroyBox(b)} disabled={busyBoxId === b.id} className="rounded-lg border border-surface-700 px-3 py-1.5 text-sm font-semibold text-surface-200 hover:bg-surface-800 disabled:opacity-50">
                              {busyBoxId === b.id ? t('runtimeBox.cleanup.cleaning') : t('runtimeBox.cleanup.confirm')}
                            </button>
                            <span className="max-w-[220px] text-[13px] leading-snug text-surface-500">{t('runtimeBox.cleanup.hint')}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="overflow-hidden rounded-xl border border-surface-800 bg-surface-900/70">
          <div className="border-b border-surface-800 px-4 py-3 text-base font-semibold text-surface-200">{t('runtimeBox.serviceList')}</div>
          {!data || services.length === 0 ? (
            <div className="p-8 text-center text-base text-surface-500">
              {loading ? t('runtimeBox.loadingServices') : t('runtimeBox.noServices')}
            </div>
          ) : (
            <div className="divide-y divide-surface-800">
              {services.map((s) => {
                const parsed = parseCommand(s.command);
                return (
                  <div key={s.id} className="p-4">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-gray-100">{s.display_name || s.name}</span>
                          <span className="rounded-full border border-surface-700 px-2 py-0.5 text-sm text-surface-300">{projectLabel(s)}</span>
                          <span className={`tone-pill px-2 py-0.5 text-sm ${badgeClass(s.status)}`}>{s.status}</span>
                          {s.internal_port && <span className="rounded-full border border-surface-700 px-2 py-0.5 text-sm text-surface-400">:{s.internal_port}</span>}
                          {s.process_pid && <span className="text-sm text-surface-500">pid {s.process_pid}</span>}
                        </div>
                        <div className="truncate font-mono text-sm text-surface-300" title={parsed.clean}>{parsed.clean}</div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-surface-500">
                          {parsed.envCount > 0 && <span title={parsed.hiddenEnvKeys.join(', ')}>env vars hidden: {parsed.envCount}</span>}
                          <span>CWD {s.cwd || '/workspace'}</span>
                          <span>Expires {fmtDate(s.expires_at)}</span>
                          {s.last_error && <span className="text-red-300">{s.last_error}</span>}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        {s.external_url && (
                          <a href={s.external_url} target="_blank" rel="noopener noreferrer" className="rounded-lg bg-primary-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-500">
                            Preview
                          </a>
                        )}
                        <button onClick={() => openLogs(s)} disabled={logsLoading === s.id} className="rounded-lg border border-surface-700 px-3 py-1.5 text-sm font-semibold text-surface-200 hover:bg-surface-800 disabled:opacity-50">
                          {logsLoading === s.id ? 'Loading…' : 'Logs'}
                        </button>
                        {s.status === 'running' && (
                          <button onClick={() => stopService(s)} disabled={stoppingServiceId === s.id} className="rounded-lg border border-red-500/40 px-3 py-1.5 text-sm font-semibold text-red-300 hover:bg-red-500/10 disabled:opacity-50">
                            {stoppingServiceId === s.id ? 'Stopping…' : 'Stop'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {logs && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setLogs(null)}>
          <div className="flex max-h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-surface-700 bg-surface-950 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-surface-800 px-4 py-3">
              <div>
                <div className="text-base font-semibold text-gray-100">{logs.service.name} logs</div>
                <div className="text-sm text-surface-500">{logs.service.log_path || 'runtime log'}</div>
              </div>
              <button onClick={() => setLogs(null)} className="rounded-lg px-2 py-1 text-base text-surface-400 hover:bg-surface-800 hover:text-gray-100">Close</button>
            </div>
            <pre className="overflow-auto whitespace-pre-wrap p-4 font-mono text-sm leading-relaxed text-surface-200">{logs.text || '(no logs)'}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-surface-800 bg-surface-900/70 p-4">
      <div className="text-sm text-surface-500">{label}</div>
      <div className="mt-1 text-base font-medium text-gray-100">{value}</div>
    </div>
  );
}
