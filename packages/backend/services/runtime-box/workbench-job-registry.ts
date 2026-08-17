/**
 * Owns: Durable registry and lifecycle transitions for Workbench one-shot jobs.
 * Public API: createWorkbenchJob, runWorkbenchJob, get/list/cancelWorkbenchJob.
 *
 * Job rows preserve command attribution, Workbench revision, bounded output, and
 * terminal outcome. Local cancellation is cooperative at the registry boundary;
 * hard process interruption is a later runner capability.
 */

import { randomUUID } from 'node:crypto';
import { execute, query, queryOne } from '../../db/pg-repo.js';
import type { ExecResult } from './types.js';

export type WorkbenchJobStatus = 'queued' | 'running' | 'cancel_requested' | 'succeeded' | 'failed' | 'cancelled';

export interface WorkbenchJobRow {
  id: number;
  project_id: string;
  box_id: number | null;
  requested_by_user_id: number;
  requested_by_session_id: string;
  provider_kind: 'local-runtime' | 'remote-worker';
  runner_kind: 'local-process' | 'remote-worker';
  status: WorkbenchJobStatus;
  command: string;
  cwd: string | null;
  timeout_seconds: number | null;
  environment_keys: string[];
  workbench_revision: number | null;
  exit_code: number | null;
  stdout_text: string | null;
  stderr_text: string | null;
  result_json: Record<string, unknown> | null;
  error_code: string | null;
  error_summary: string | null;
  cancel_requested_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  claim_token: string | null;
  runner_id: string | null;
  heartbeat_at: string | null;
  lease_expires_at: string | null;
  attempt: number;
}

export interface WorkbenchJobExecution {
  job: WorkbenchJobRow;
  result?: ExecResult;
}

const MAX_OUTPUT_CHARS = 200_000;

function normalizeJob(row: any): WorkbenchJobRow {
  return {
    ...row,
    id: Number(row.id),
    box_id: row.box_id == null ? null : Number(row.box_id),
    requested_by_user_id: Number(row.requested_by_user_id),
    workbench_revision: row.workbench_revision == null ? null : Number(row.workbench_revision),
    exit_code: row.exit_code == null ? null : Number(row.exit_code),
    timeout_seconds: row.timeout_seconds == null ? null : Number(row.timeout_seconds),
    environment_keys: Array.isArray(row.environment_keys) ? row.environment_keys : [],
    claim_token: row.claim_token ?? null,
    runner_id: row.runner_id ?? null,
    heartbeat_at: row.heartbeat_at ?? null,
    lease_expires_at: row.lease_expires_at ?? null,
    attempt: Number(row.attempt ?? 0),
  };
}

function boundedOutput(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n[Tower truncated durable Job output after ${MAX_OUTPUT_CHARS} characters]`;
}

/** Create a queued durable Job and pin its starting Workbench revision. */
export async function createWorkbenchJob(input: {
  projectId: string;
  userId: number;
  sessionId: string;
  command: string;
  cwd?: string;
  timeoutSec?: number;
  env?: Record<string, string>;
  providerKind?: 'local-runtime' | 'remote-worker';
}): Promise<WorkbenchJobRow> {
  const providerKind = input.providerKind ?? 'local-runtime';
  const runnerKind = providerKind === 'local-runtime' ? 'local-process' : 'remote-worker';
  const row = await queryOne<any>(
    `INSERT INTO runtime_box_workbench_jobs(
       project_id,requested_by_user_id,requested_by_session_id,provider_kind,runner_kind,status,
       command,cwd,timeout_seconds,environment_keys,workbench_revision
     ) VALUES($1,$2,$3,$4,$5,'queued',$6,$7,$8,$9::jsonb,
       (SELECT current_revision FROM runtime_box_workbench_tool_states WHERE project_id=$1))
     RETURNING *`,
    [input.projectId, input.userId, input.sessionId, providerKind, runnerKind, input.command,
      input.cwd ?? null, input.timeoutSec ?? null, JSON.stringify(Object.keys(input.env ?? {}).sort())],
  );
  if (!row) throw new Error('Failed to create Workbench Job');
  return normalizeJob(row);
}

/** Fetch one Project-scoped Job. */
export async function getWorkbenchJob(projectId: string, jobId: number): Promise<WorkbenchJobRow | undefined> {
  const row = await queryOne<any>('SELECT * FROM runtime_box_workbench_jobs WHERE project_id=$1 AND id=$2', [projectId, jobId]);
  return row ? normalizeJob(row) : undefined;
}

/** List newest Project Jobs without exposing environment values. */
export async function listWorkbenchJobs(projectId: string, limit = 20): Promise<WorkbenchJobRow[]> {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  return (await query<any>('SELECT * FROM runtime_box_workbench_jobs WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2', [projectId, boundedLimit])).map(normalizeJob);
}

/** Atomically claim one queued Job for a background runner lease. */
export async function claimWorkbenchJob(input: { jobId: number; projectId: string; runnerId: string; leaseSeconds?: number }): Promise<WorkbenchJobRow | undefined> {
  const leaseSeconds = Math.min(Math.max(Math.trunc(input.leaseSeconds ?? 30), 5), 300);
  const claimToken = randomUUID();
  const row = await queryOne<any>(
    `UPDATE runtime_box_workbench_jobs
       SET status='running',claim_token=$4,runner_id=$3,started_at=COALESCE(started_at,NOW()),
           heartbeat_at=NOW(),lease_expires_at=NOW()+($5 * INTERVAL '1 second'),attempt=attempt+1,updated_at=NOW()
     WHERE id=$1 AND project_id=$2 AND status='queued' RETURNING *`,
    [input.jobId, input.projectId, input.runnerId, claimToken, leaseSeconds],
  );
  return row ? normalizeJob(row) : undefined;
}

/** Extend one active runner lease only when the claim token still owns the Job. */
export async function heartbeatWorkbenchJob(input: { jobId: number; projectId: string; claimToken: string; leaseSeconds?: number }): Promise<boolean> {
  const leaseSeconds = Math.min(Math.max(Math.trunc(input.leaseSeconds ?? 30), 5), 300);
  const result = await execute(
    `UPDATE runtime_box_workbench_jobs SET heartbeat_at=NOW(),lease_expires_at=NOW()+($4 * INTERVAL '1 second'),updated_at=NOW()
     WHERE id=$1 AND project_id=$2 AND claim_token=$3 AND status IN ('running','cancel_requested')`,
    [input.jobId, input.projectId, input.claimToken, leaseSeconds],
  );
  return result.changes === 1;
}

/** Persist one bounded live-output chunk while the same runner claim still owns the Job. */
export async function appendWorkbenchJobOutput(input: {
  jobId: number;
  projectId: string;
  claimToken: string;
  stream: 'stdout' | 'stderr';
  chunk: string;
}): Promise<boolean> {
  if (!input.chunk) return true;
  const column = input.stream === 'stdout' ? 'stdout_text' : 'stderr_text';
  const result = await execute(
    `UPDATE runtime_box_workbench_jobs
       SET ${column}=LEFT(COALESCE(${column},'') || $4,$5),updated_at=NOW()
     WHERE id=$1 AND project_id=$2 AND claim_token=$3 AND status IN ('running','cancel_requested')`,
    [input.jobId, input.projectId, input.claimToken, input.chunk, MAX_OUTPUT_CHARS],
  );
  return result.changes === 1;
}

/** Mark expired runner leases failed; automatic replay is intentionally forbidden. */
export async function reconcileStaleWorkbenchJobs(): Promise<number> {
  const result = await execute(
    `UPDATE runtime_box_workbench_jobs SET status='failed',error_code='RUNNER_LEASE_EXPIRED',
       error_summary='Workbench Job runner heartbeat expired; automatic replay is disabled',finished_at=NOW(),updated_at=NOW()
     WHERE status IN ('running','cancel_requested') AND lease_expires_at IS NOT NULL AND lease_expires_at<NOW()`,
  );
  return result.changes;
}

/** Request cancellation. Queued jobs cancel immediately; running jobs notify the owning local runner. */
export async function cancelWorkbenchJob(projectId: string, jobId: number): Promise<WorkbenchJobRow> {
  const row = await queryOne<any>(
    `UPDATE runtime_box_workbench_jobs
       SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancel_requested' END,
           cancel_requested_at=NOW(),
           finished_at=CASE WHEN status='queued' THEN NOW() ELSE finished_at END,
           updated_at=NOW()
     WHERE project_id=$1 AND id=$2 AND status IN ('queued','running')
     RETURNING *`,
    [projectId, jobId],
  );
  if (row) return normalizeJob(row);
  const existing = await getWorkbenchJob(projectId, jobId);
  if (!existing) throw new Error(`Workbench Job ${jobId} not found`);
  return existing;
}

/** Claim and run one queued Job through a provider runner, then persist its terminal result. */
export async function runClaimedWorkbenchJob(input: {
  job: WorkbenchJobRow;
  run: () => Promise<ExecResult>;
}): Promise<WorkbenchJobExecution> {
  if (!input.job.claim_token || input.job.status !== 'running') throw new Error(`Workbench Job ${input.job.id} is not actively claimed`);
  try {
    const result = await input.run();
    const latest = await getWorkbenchJob(input.job.project_id, input.job.id);
    const cancelled = latest?.status === 'cancel_requested';
    const terminal = cancelled ? 'cancelled' : result.exit_code === 0 ? 'succeeded' : 'failed';
    const finalized = await queryOne<any>(
      `UPDATE runtime_box_workbench_jobs
         SET status=$3,box_id=COALESCE($4,box_id),exit_code=$5,stdout_text=$6,stderr_text=$7,
             result_json=$8::jsonb,error_code=$9,error_summary=$10,finished_at=NOW(),updated_at=NOW()
       WHERE id=$1 AND project_id=$2 AND claim_token=$11 AND status IN ('running','cancel_requested') RETURNING *`,
      [input.job.id, input.job.project_id, terminal, null, result.exit_code,
        boundedOutput(result.stdout), boundedOutput(result.stderr), JSON.stringify({ timedOut: result.timed_out, oomKilled: result.oom_killed, durationMs: result.duration_ms }),
        terminal === 'failed' ? (result.timed_out ? 'TIMEOUT' : result.oom_killed ? 'OOM_KILLED' : 'NON_ZERO_EXIT') : null,
        terminal === 'failed' ? `Workbench Job exited with code ${result.exit_code}` : null, input.job.claim_token],
    );
    if (!finalized) throw new Error(`Workbench Job ${input.job.id} could not finalize`);
    return { job: normalizeJob(finalized), result };
  } catch (error) {
    await execute(
      `UPDATE runtime_box_workbench_jobs SET status=CASE WHEN status='cancel_requested' THEN 'cancelled' ELSE 'failed' END,
         error_code=CASE WHEN status='cancel_requested' THEN NULL ELSE 'RUNNER_ERROR' END,
         error_summary=$3,finished_at=NOW(),updated_at=NOW()
       WHERE id=$1 AND project_id=$2 AND claim_token=$4 AND status IN ('running','cancel_requested')`,
      [input.job.id, input.job.project_id, (error as Error).message.slice(0, 2000), input.job.claim_token],
    );
    const failed = await getWorkbenchJob(input.job.project_id, input.job.id);
    if (!failed) throw error;
    return { job: failed };
  }
}
