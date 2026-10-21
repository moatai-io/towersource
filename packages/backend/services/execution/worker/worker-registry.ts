/**
 * Owns: in-memory Worker registration, heartbeat, capacity, drain, and selection contract.
 * Public API: registerWorkbenchWorker, heartbeatWorkbenchWorker, selectWorkbenchWorker,
 *             listWorkbenchWorkers, setWorkbenchWorkerDrain.
 *
 * This is the first control-plane scheduler seam. Durable persistence and Worker-authenticated
 * registration are follow-up gates; callers cannot choose a Worker directly.
 */

export type WorkbenchWorkerStatus = 'healthy' | 'stale' | 'draining';

export interface WorkbenchWorkerCapacity {
  cpuTotal: number;
  memoryMbTotal: number;
  activeRuns: number;
  maxRuns: number;
}

export interface WorkbenchWorkerRegistration {
  workerId: string;
  deploymentId: string;
  baseUrl: string;
  capabilities: string[];
  projectIds: string[];
  capacity: WorkbenchWorkerCapacity;
  registeredAt: string;
  heartbeatAt: string;
  draining: boolean;
}

export interface WorkbenchWorkerView extends WorkbenchWorkerRegistration {
  status: WorkbenchWorkerStatus;
}

const workers = new Map<string, WorkbenchWorkerRegistration>();
const WORKER_ID = /^[a-zA-Z0-9._-]{1,120}$/;

function normalizeUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('WORKER_URL_INVALID');
  return url.toString().replace(/\/$/, '');
}

function status(worker: WorkbenchWorkerRegistration, now: number, staleAfterMs: number): WorkbenchWorkerStatus {
  if (worker.draining) return 'draining';
  return now - Date.parse(worker.heartbeatAt) > staleAfterMs ? 'stale' : 'healthy';
}

/** Register or refresh non-secret Worker metadata. Authentication belongs at the API boundary. */
export function registerWorkbenchWorker(input: {
  workerId: string;
  deploymentId: string;
  baseUrl: string;
  capabilities: string[];
  projectIds: string[];
  capacity: WorkbenchWorkerCapacity;
  now?: number;
}): WorkbenchWorkerView {
  if (!WORKER_ID.test(input.workerId)) throw new Error('WORKER_ID_INVALID');
  if (input.capacity.maxRuns < 1 || input.capacity.activeRuns < 0 || input.capacity.activeRuns > input.capacity.maxRuns) {
    throw new Error('WORKER_CAPACITY_INVALID');
  }
  const now = input.now ?? Date.now();
  const existing = workers.get(input.workerId);
  const worker: WorkbenchWorkerRegistration = {
    workerId: input.workerId,
    deploymentId: input.deploymentId,
    baseUrl: normalizeUrl(input.baseUrl),
    capabilities: [...new Set(input.capabilities)].sort(),
    projectIds: [...new Set(input.projectIds)].sort(),
    capacity: { ...input.capacity },
    registeredAt: existing?.registeredAt ?? new Date(now).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
    draining: existing?.draining ?? false,
  };
  workers.set(worker.workerId, worker);
  return { ...worker, status: worker.draining ? 'draining' : 'healthy' };
}

/** Refresh liveness and current capacity without changing identity or allowlists. */
export function heartbeatWorkbenchWorker(input: {
  workerId: string;
  capacity: WorkbenchWorkerCapacity;
  now?: number;
}): WorkbenchWorkerView {
  const worker = workers.get(input.workerId);
  if (!worker) throw new Error('WORKER_NOT_REGISTERED');
  return registerWorkbenchWorker({ ...worker, capacity: input.capacity, now: input.now });
}

/** Drain prevents new Runs while leaving current Runs observable. */
export function setWorkbenchWorkerDrain(workerId: string, draining: boolean): WorkbenchWorkerView {
  const worker = workers.get(workerId);
  if (!worker) throw new Error('WORKER_NOT_REGISTERED');
  worker.draining = draining;
  return { ...worker, status: draining ? 'draining' : 'healthy' };
}

/** Select a healthy, Project-authorized, capability-compatible Worker with the most free slots. */
export function selectWorkbenchWorker(input: {
  projectId: string;
  deploymentId?: string;
  requiredCapabilities?: string[];
  preferredWorkerId?: string;
  now?: number;
  staleAfterMs?: number;
}): WorkbenchWorkerView {
  const now = input.now ?? Date.now();
  const staleAfterMs = input.staleAfterMs ?? 15_000;
  const required = input.requiredCapabilities ?? [];
  const preferredWorkerId = input.preferredWorkerId?.trim() || undefined;
  const candidates = [...workers.values()].filter(worker =>
    status(worker, now, staleAfterMs) === 'healthy'
    && (!input.deploymentId || worker.deploymentId === input.deploymentId)
    && worker.projectIds.includes(input.projectId)
    && required.every(capability => worker.capabilities.includes(capability))
    && worker.capacity.activeRuns < worker.capacity.maxRuns,
  ).sort((a, b) => {
    const preferred = (a.workerId === preferredWorkerId ? 0 : 1) - (b.workerId === preferredWorkerId ? 0 : 1);
    const free = (b.capacity.maxRuns - b.capacity.activeRuns) - (a.capacity.maxRuns - a.capacity.activeRuns);
    return preferred || free || a.workerId.localeCompare(b.workerId);
  });
  if (!candidates[0]) throw new Error('NO_ELIGIBLE_WORKER');
  return { ...candidates[0], status: 'healthy' };
}

/** Return non-secret scheduler state for operator diagnostics. */
export function listWorkbenchWorkers(input: { now?: number; staleAfterMs?: number } = {}): WorkbenchWorkerView[] {
  const now = input.now ?? Date.now();
  const staleAfterMs = input.staleAfterMs ?? 15_000;
  return [...workers.values()].map(worker => ({ ...worker, status: status(worker, now, staleAfterMs) }))
    .sort((a, b) => a.workerId.localeCompare(b.workerId));
}

/** Test helper; production lifecycle will move to a durable registry. */
export function clearWorkbenchWorkerRegistry(): void {
  workers.clear();
}
