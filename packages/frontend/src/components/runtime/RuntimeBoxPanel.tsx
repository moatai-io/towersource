import React from 'react';
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
  return { label: `이전 오류(복구됨): ${box.last_error}`, className: 'text-surface-500' };
}

export function RuntimeBoxPanel() {
  const confirm = useConfirm();
  const canEditCapacity = getCurrentRole() === 'admin';
  const [data, setData] = React.useState<ServicesResponse | null>(null);
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
        title: '권장 용량 초과 설정',
        message: '현재 서버 사양에서 권장하는 수보다 큽니다. 메모리 부족이나 작업 지연이 생길 수 있지만 저장은 가능합니다. 그대로 적용할까요?',
        confirmLabel: '초과 설정 적용',
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
      toastSuccess('Runtime Box 용량 설정을 즉시 적용했습니다.');
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
      title: 'Runtime Box 실행 중지',
      message: `${projectLabel(box)}의 실행 중인 dev service를 중지하고 Runtime Box를 내립니다. 프로젝트 파일은 삭제되지 않습니다.`,
      confirmLabel: '실행 중지',
      danger: true,
    });
    if (!ok) return;
    setBusyBoxId(box.id);
    try {
      const res = await fetch(`/api/runtime-box/boxes/${box.id}/stop`, { method: 'POST', headers: authHeaders() });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      toastSuccess(`Runtime Box 실행 중지 완료 (#${box.id})`);
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
      title: 'Runtime Box 임시 정리',
      message: `${projectLabel(box)}의 임시 실행 상태와 남은 컨테이너를 정리합니다. 컨테이너 이름 충돌이나 오래된 실행 흔적 때문에 다시 켜지지 않을 때 필요합니다. 프로젝트 파일은 삭제되지 않으며, 다음에 필요하면 같은 프로젝트에서 다시 켤 수 있습니다.`,
      confirmLabel: '임시 정리',
      danger: true,
    });
    if (!ok) return;
    setBusyBoxId(box.id);
    try {
      const res = await fetch(`/api/runtime-box/boxes/${box.id}`, { method: 'DELETE', headers: authHeaders() });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      toastSuccess(`Runtime Box 임시 정리 완료 (#${box.id})`);
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
            <div className="text-sm uppercase tracking-[0.24em] text-primary-400/80">Project Runtime Box</div>
            <h1 className="mt-1 text-3xl font-semibold text-gray-100">VM Runtime Services</h1>
            <p className="mt-1 text-base text-surface-400">Preview는 임시 개발 서버입니다. 지속 공유 URL은 명시적으로 Publish할 때만 생성됩니다.</p>
          </div>
          <button onClick={load} disabled={loading} className="rounded-lg border border-surface-700 bg-surface-850 px-3 py-2 text-base text-surface-200 hover:bg-surface-800 disabled:opacity-50">
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <Stat label="Runtime boxes" value={boxes.length} />
          <Stat label="Running boxes" value={runningBoxes} />
          <Stat label="Active/problem services" value={services.length} />
        </div>

        {capacity && <section className="rounded-xl border border-surface-800 bg-surface-900/70 p-4 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-surface-100">실행 용량</h2>
            <p className="mt-1 text-sm text-surface-400">현재 서버: CPU {capacity.host.cpuThreads} threads · RAM {(capacity.host.totalMemoryMb / 1024).toFixed(1)}GB · Box당 최대 {(capacity.box.maxMemoryMb / 1024).toFixed(1)}GB</p>
            <p className="mt-1 text-sm text-surface-500">권장값은 RAM의 70%와 CPU 여유를 기준으로 계산합니다. 더 큰 값도 경고 확인 후 저장할 수 있습니다.</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-sm text-surface-300">
              <span>서버 전체 동시 Box · 권장 {capacity.recommended.maxRunning}</span>
              <input type="number" min={1} value={capacityDraft.maxRunning} onChange={(e) => setCapacityDraft((v) => ({ ...v, maxRunning: Number(e.target.value) }))} className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-surface-100" />
            </label>
            <label className="space-y-1 text-sm text-surface-300">
              <span>사용자당 동시 Box · 권장 {capacity.recommended.maxRunningPerUser}</span>
              <input type="number" min={1} value={capacityDraft.maxRunningPerUser} onChange={(e) => setCapacityDraft((v) => ({ ...v, maxRunningPerUser: Number(e.target.value) }))} className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-surface-100" />
            </label>
          </div>
          {(capacityDraft.maxRunning > capacity.recommended.maxRunning || capacityDraft.maxRunningPerUser > capacity.recommended.maxRunningPerUser) && <div className="tone-card tone-warning rounded-lg p-3 text-sm">권장량을 초과했습니다. 저장 시 한 번 더 확인합니다.</div>}
          {capacityDraft.maxRunningPerUser > capacityDraft.maxRunning && <div className="text-sm text-surface-500">사용자당 값이 전체 값보다 커도 저장할 수 있지만 실제 동시 실행은 전체 한도에 먼저 막힙니다.</div>}
          {canEditCapacity ? <div className="flex justify-end"><button onClick={saveCapacity} disabled={capacitySaving || capacityDraft.maxRunning < 1 || capacityDraft.maxRunningPerUser < 1} className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-500 disabled:opacity-50">{capacitySaving ? '저장 중…' : '용량 설정 저장'}</button></div> : <p className="text-sm text-surface-500">Operator는 현재 설정을 조회할 수 있고, 변경은 Admin만 할 수 있습니다.</p>}
        </section>}

        <section className="overflow-hidden rounded-xl border border-surface-800 bg-surface-900/70">
          <div className="border-b border-surface-800 px-4 py-3 text-base font-semibold text-surface-200">Boxes</div>
          {boxes.length === 0 ? (
            <div className="p-8 text-center text-base text-surface-500">{loading ? 'Loading boxes…' : 'Runtime Box row가 없습니다.'}</div>
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
                            {busyBoxId === b.id ? '중지 중…' : '실행 중지'}
                          </button>
                        )}
                        {b.status !== 'running' && b.status !== 'starting' && (
                          <div className="flex flex-col items-start gap-1">
                            <button onClick={() => destroyBox(b)} disabled={busyBoxId === b.id} className="rounded-lg border border-surface-700 px-3 py-1.5 text-sm font-semibold text-surface-200 hover:bg-surface-800 disabled:opacity-50">
                              {busyBoxId === b.id ? '정리 중…' : '임시 정리'}
                            </button>
                            <span className="max-w-[220px] text-[13px] leading-snug text-surface-500">컨테이너 충돌·오래된 실행 흔적 정리. 파일은 유지됩니다.</span>
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
          <div className="border-b border-surface-800 px-4 py-3 text-base font-semibold text-surface-200">Services</div>
          {!data || services.length === 0 ? (
            <div className="p-8 text-center text-base text-surface-500">
              {loading ? 'Loading services…' : '현재 running/pending/error/expired service가 없습니다.'}
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
