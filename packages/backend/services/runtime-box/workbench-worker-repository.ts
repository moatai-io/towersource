/**
 * Owns: PostgreSQL persistence and scheduling queries for Remote Workbench Workers.
 * Public API: upsert/heartbeat/drain/get/list/select durable Worker metadata.
 * See: workspace/decisions/2026-08-10-tower-control-plane-only-project-compute.md.
 */

import { execute, query, queryOne } from '../../db/pg-repo.js';
import type {
  WorkbenchWorkerCapacity,
  WorkbenchWorkerStatus,
  WorkbenchWorkerView,
} from './workbench-worker-registry.js';

type WorkerDbRow = {
  worker_id: string;
  base_url: string;
  capabilities: string[];
  metadata_json: { deploymentId?: string } | null;
  project_ids: string[];
  cpu_total: number;
  memory_mb_total: number;
  active_runs: number;
  max_runs: number;
  draining: boolean;
  registered_at: string;
  heartbeat_at: string;
};

const WORKER_ID = /^[a-zA-Z0-9._-]{1,120}$/;

function validateCapacity(capacity: WorkbenchWorkerCapacity): void {
  if (!Number.isInteger(capacity.cpuTotal) || capacity.cpuTotal < 0
    || !Number.isInteger(capacity.memoryMbTotal) || capacity.memoryMbTotal < 0
    || !Number.isInteger(capacity.activeRuns) || capacity.activeRuns < 0
    || !Number.isInteger(capacity.maxRuns) || capacity.maxRuns < 1
    || capacity.activeRuns > capacity.maxRuns) throw new Error('WORKER_CAPACITY_INVALID');
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('WORKER_URL_INVALID');
  return url.toString().replace(/\/$/, '');
}

function normalizeRow(row: WorkerDbRow, now: number, staleAfterMs: number): WorkbenchWorkerView {
  const heartbeat = new Date(row.heartbeat_at).toISOString();
  const workerStatus: WorkbenchWorkerStatus = row.draining
    ? 'draining'
    : now - Date.parse(heartbeat) > staleAfterMs ? 'stale' : 'healthy';
  return {
    workerId: row.worker_id,
    deploymentId: row.metadata_json?.deploymentId ?? 'unscoped',
    baseUrl: row.base_url,
    capabilities: row.capabilities ?? [],
    projectIds: row.project_ids ?? [],
    capacity: {
      cpuTotal: Number(row.cpu_total), memoryMbTotal: Number(row.memory_mb_total),
      activeRuns: Number(row.active_runs), maxRuns: Number(row.max_runs),
    },
    draining: row.draining,
    registeredAt: new Date(row.registered_at).toISOString(),
    heartbeatAt: heartbeat,
    status: workerStatus,
  };
}

/** Insert or refresh durable non-sensitive Worker registration metadata. */
export async function upsertWorkbenchWorker(input: {
  workerId: string;
  deploymentId: string;
  baseUrl: string;
  capabilities: string[];
  projectIds: string[];
  capacity: WorkbenchWorkerCapacity;
}): Promise<WorkbenchWorkerView> {
  if (!WORKER_ID.test(input.workerId)) throw new Error('WORKER_ID_INVALID');
  validateCapacity(input.capacity);
  const row = await queryOne<WorkerDbRow>(
    `INSERT INTO runtime_box_workbench_workers(
       worker_id,base_url,capabilities,project_ids,cpu_total,memory_mb_total,active_runs,max_runs,metadata_json
     ) VALUES($1,$2,$3::text[],$4::text[],$5,$6,$7,$8,jsonb_build_object('deploymentId',$9::text))
     ON CONFLICT(worker_id) DO UPDATE SET
       base_url=EXCLUDED.base_url,capabilities=EXCLUDED.capabilities,project_ids=EXCLUDED.project_ids,
       cpu_total=EXCLUDED.cpu_total,memory_mb_total=EXCLUDED.memory_mb_total,
       active_runs=EXCLUDED.active_runs,max_runs=EXCLUDED.max_runs,metadata_json=EXCLUDED.metadata_json,
       heartbeat_at=NOW(),updated_at=NOW()
     RETURNING *`,
    [input.workerId, normalizeUrl(input.baseUrl), [...new Set(input.capabilities)].sort(),
      [...new Set(input.projectIds)].sort(), input.capacity.cpuTotal, input.capacity.memoryMbTotal,
      input.capacity.activeRuns, input.capacity.maxRuns, input.deploymentId],
  );
  if (!row) throw new Error('WORKER_REGISTRATION_FAILED');
  return normalizeRow(row, Date.now(), 15_000);
}

/** Refresh liveness and capacity without allowing heartbeat to rewrite identity or Project scope. */
export async function heartbeatPersistedWorkbenchWorker(input: {
  workerId: string;
  capacity: WorkbenchWorkerCapacity;
}): Promise<WorkbenchWorkerView> {
  validateCapacity(input.capacity);
  const row = await queryOne<WorkerDbRow>(
    `UPDATE runtime_box_workbench_workers SET cpu_total=$2,memory_mb_total=$3,
       max_runs=GREATEST($4,active_runs),heartbeat_at=NOW(),updated_at=NOW()
       WHERE worker_id=$1 RETURNING *`,
    [input.workerId, input.capacity.cpuTotal, input.capacity.memoryMbTotal, input.capacity.maxRuns],
  );
  if (!row) throw new Error('WORKER_NOT_REGISTERED');
  return normalizeRow(row, Date.now(), 15_000);
}

/** Change new-Run eligibility without losing liveness and current Run visibility. */
export async function setPersistedWorkbenchWorkerDrain(workerId: string, draining: boolean): Promise<WorkbenchWorkerView> {
  const row = await queryOne<WorkerDbRow>(
    'UPDATE runtime_box_workbench_workers SET draining=$2,updated_at=NOW() WHERE worker_id=$1 RETURNING *',
    [workerId, draining],
  );
  if (!row) throw new Error('WORKER_NOT_REGISTERED');
  return normalizeRow(row, Date.now(), 15_000);
}

/** Read one Worker for operator diagnostics. */
export async function getPersistedWorkbenchWorker(workerId: string, input: { now?: number; staleAfterMs?: number } = {}): Promise<WorkbenchWorkerView | undefined> {
  const row = await queryOne<WorkerDbRow>('SELECT * FROM runtime_box_workbench_workers WHERE worker_id=$1', [workerId]);
  return row ? normalizeRow(row, input.now ?? Date.now(), input.staleAfterMs ?? 15_000) : undefined;
}

/** List durable Worker state without authentication material. */
export async function listPersistedWorkbenchWorkers(input: { now?: number; staleAfterMs?: number } = {}): Promise<WorkbenchWorkerView[]> {
  const now = input.now ?? Date.now();
  const staleAfterMs = input.staleAfterMs ?? 15_000;
  return (await query<WorkerDbRow>('SELECT * FROM runtime_box_workbench_workers ORDER BY worker_id')).map(row => normalizeRow(row, now, staleAfterMs));
}

/** Select a healthy authorized Worker without consuming a transient Run slot. */
export async function selectPersistedWorkbenchWorker(input: {
  projectId: string;
  deploymentId?: string;
  requiredCapabilities?: string[];
  preferredWorkerId?: string;
  staleAfterMs?: number;
}): Promise<WorkbenchWorkerView> {
  const staleAfterMs = Math.min(Math.max(Math.trunc(input.staleAfterMs ?? 15_000), 1_000), 300_000);
  const preferredWorkerId = input.preferredWorkerId?.trim() || null;
  const row = await queryOne<WorkerDbRow>(
    `SELECT * FROM runtime_box_workbench_workers
     WHERE draining=FALSE AND heartbeat_at >= NOW()-($3 * INTERVAL '1 millisecond')
       AND ($5::text IS NULL OR metadata_json->>'deploymentId'=$5)
       AND active_runs < max_runs AND $1 = ANY(project_ids) AND capabilities @> $2::text[]
     ORDER BY CASE WHEN worker_id=$4 THEN 0 ELSE 1 END, (max_runs-active_runs) DESC, worker_id ASC LIMIT 1`,
    [input.projectId, [...new Set(input.requiredCapabilities ?? [])].sort(), staleAfterMs, preferredWorkerId, input.deploymentId?.trim() || null],
  );
  if (!row) throw new Error('NO_ELIGIBLE_WORKER');
  return normalizeRow(row, Date.now(), staleAfterMs);
}

/** Atomically select one Worker and reserve one transient foreground/Job slot. */
export async function reservePersistedWorkbenchWorkerSlot(input: {
  projectId: string;
  deploymentId: string;
  requiredCapabilities?: string[];
  preferredWorkerId?: string;
  staleAfterMs?: number;
  weight?: number;
}): Promise<WorkbenchWorkerView> {
  const staleAfterMs = Math.min(Math.max(Math.trunc(input.staleAfterMs ?? 15_000), 1_000), 300_000);
  const weight = Math.trunc(input.weight ?? 1);
  if (weight < 1 || weight > 1000) throw new Error('WORKER_CAPACITY_WEIGHT_INVALID');
  const row = await queryOne<WorkerDbRow>(
    `WITH candidate AS (
       SELECT worker_id FROM runtime_box_workbench_workers
        WHERE draining=FALSE AND heartbeat_at >= NOW()-($3 * INTERVAL '1 millisecond')
          AND metadata_json->>'deploymentId'=$5
          AND active_runs+$6 <= max_runs AND $1 = ANY(project_ids) AND capabilities @> $2::text[]
        ORDER BY CASE WHEN worker_id=$4 THEN 0 ELSE 1 END, (max_runs-active_runs) DESC, worker_id ASC
        FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE runtime_box_workbench_workers w SET active_runs=w.active_runs+$6,updated_at=NOW()
      FROM candidate c WHERE w.worker_id=c.worker_id RETURNING w.*`,
    [input.projectId, [...new Set(input.requiredCapabilities ?? [])].sort(), staleAfterMs,
      input.preferredWorkerId?.trim() || null, input.deploymentId, weight],
  );
  if (!row) {
    const preferredWorkerId = input.preferredWorkerId?.trim();
    if (!preferredWorkerId) throw new Error('WORKER_BUSY: no Worker has enough free capacity for this request');
    const preferred = await getPersistedWorkbenchWorker(preferredWorkerId, { staleAfterMs });
    if (!preferred) throw new Error(`WORKSTATION_WORKER_NOT_REGISTERED: ${preferredWorkerId}; operator action is required`);
    if (preferred.deploymentId !== input.deploymentId) throw new Error(`WORKSTATION_WORKER_DEPLOYMENT_MISMATCH: ${preferredWorkerId}; expected ${input.deploymentId}, got ${preferred.deploymentId}`);
    if (!preferred.projectIds.includes(input.projectId)) throw new Error(`WORKSTATION_WORKER_PROJECT_SCOPE_MISMATCH: ${preferredWorkerId}; operator action is required`);
    const missingCapabilities = [...new Set(input.requiredCapabilities ?? [])].filter(capability => !preferred.capabilities.includes(capability));
    if (missingCapabilities.length > 0) throw new Error(`WORKSTATION_WORKER_CAPABILITY_MISSING: ${preferredWorkerId}; missing ${missingCapabilities.join(',')}`);
    if (preferred.draining) throw new Error(`WORKSTATION_WORKER_DRAINING: ${preferredWorkerId}; new commands are temporarily disabled for maintenance`);
    if (preferred.status === 'stale') throw new Error(`WORKSTATION_WORKER_HEARTBEAT_STALE: ${preferredWorkerId}; operator action may be required`);
    if (preferred.capacity.maxRuns < weight) throw new Error(`WORKSTATION_WORKER_CAPACITY_CONFIG_INVALID: ${preferredWorkerId}; request requires ${weight} capacity units but Worker maximum is ${preferred.capacity.maxRuns}; operator action is required`);
    throw new Error(`WORKSTATION_WORKER_BUSY: ${preferredWorkerId}; ${preferred.capacity.activeRuns}/${preferred.capacity.maxRuns} capacity units are in use; retry after the current command finishes`);
  }
  return normalizeRow(row, Date.now(), staleAfterMs);
}

/** Return one reserved transient Run slot without allowing the counter below zero. */
export async function releasePersistedWorkbenchWorkerSlot(workerId: string, weight = 1): Promise<boolean> {
  const boundedWeight = Math.trunc(weight);
  if (boundedWeight < 1 || boundedWeight > 1000) throw new Error('WORKER_CAPACITY_WEIGHT_INVALID');
  const result = await execute(
    `UPDATE runtime_box_workbench_workers SET active_runs=GREATEST(active_runs-$2,0),updated_at=NOW()
      WHERE worker_id=$1 AND active_runs>0`,
    [workerId, boundedWeight],
  );
  return result.changes === 1;
}

/** Delete a Worker only from explicit control-plane lifecycle code. */
export async function deletePersistedWorkbenchWorker(workerId: string): Promise<boolean> {
  return (await execute('DELETE FROM runtime_box_workbench_workers WHERE worker_id=$1', [workerId])).changes === 1;
}
