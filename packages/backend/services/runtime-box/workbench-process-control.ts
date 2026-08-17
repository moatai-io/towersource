/**
 * Owns: Common Project Shell process handles over durable Jobs and managed Services.
 * Public API: listWorkbenchProcesses, inspectWorkbenchProcess, readWorkbenchProcessLogs,
 *             stopWorkbenchProcess.
 *
 * Job and Service remain distinct persistence/supervision implementations. This
 * module gives the AI one observation/control contract without weakening the
 * Project ownership check at either registry boundary.
 */

import { getWorkbenchJob, listWorkbenchJobs, cancelWorkbenchJob, type WorkbenchJobRow } from './workbench-job-registry.js';
import { requestLocalWorkbenchJobCancel } from './workbench-job-runner.js';
import { requestRemoteWorkbenchJobCancel } from './workbench-remote-job-runner.js';
import { listServices, readServiceLogs, stopService } from './service-registry.js';
import type { ServiceRow } from './types.js';

export type WorkbenchProcessKind = 'job' | 'service';
export type WorkbenchProcessState = 'queued' | 'running' | 'stopping' | 'succeeded' | 'failed' | 'stopped';
export type WorkbenchProcessHandle = `job:${number}` | `service:${number}`;

export interface WorkbenchProcess {
  handle: WorkbenchProcessHandle;
  kind: WorkbenchProcessKind;
  id: number;
  projectId: string;
  state: WorkbenchProcessState;
  command: string;
  cwd: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  errorCode: string | null;
  errorSummary: string | null;
  previewUrl?: string;
  port?: number;
  durable: boolean;
}

export interface WorkbenchProcessLogs {
  handle: WorkbenchProcessHandle;
  stdout: string;
  stderr: string;
  complete: boolean;
}

export class WorkbenchProcessError extends Error {
  constructor(public readonly code: 'INVALID_HANDLE' | 'PROCESS_NOT_FOUND' | 'ACTION_NOT_SUPPORTED', message: string) {
    super(message);
    this.name = 'WorkbenchProcessError';
  }
}

/** Parse an opaque Project Shell process handle without accepting bare cross-kind ids. */
export function parseWorkbenchProcessHandle(handle: string): { kind: WorkbenchProcessKind; id: number } {
  const match = /^(job|service):([1-9]\d*)$/.exec(handle);
  if (!match) throw new WorkbenchProcessError('INVALID_HANDLE', `Invalid Project Shell process handle: ${handle}`);
  return { kind: match[1] as WorkbenchProcessKind, id: Number(match[2]) };
}

function jobState(job: WorkbenchJobRow): WorkbenchProcessState {
  if (job.status === 'cancel_requested') return 'stopping';
  if (job.status === 'cancelled') return 'stopped';
  return job.status;
}

function serviceState(service: ServiceRow): WorkbenchProcessState {
  if (service.status === 'pending' || service.status === 'running') return service.status === 'pending' ? 'queued' : 'running';
  if (service.status === 'error') return 'failed';
  return 'stopped';
}

/** Convert durable Job evidence to the common process projection. */
export function projectWorkbenchJob(job: WorkbenchJobRow): WorkbenchProcess {
  return {
    handle: `job:${job.id}`,
    kind: 'job',
    id: job.id,
    projectId: job.project_id,
    state: jobState(job),
    command: job.command,
    cwd: job.cwd,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    exitCode: job.exit_code,
    errorCode: job.error_code,
    errorSummary: job.error_summary,
    durable: true,
  };
}

/** Convert managed Service evidence to the common process projection. */
export function projectWorkbenchService(service: ServiceRow): WorkbenchProcess {
  return {
    handle: `service:${service.id}`,
    kind: 'service',
    id: service.id,
    projectId: service.project_id,
    state: serviceState(service),
    command: service.command,
    cwd: service.cwd,
    startedAt: service.started_at,
    finishedAt: service.stopped_at,
    exitCode: null,
    errorCode: service.status === 'error' ? 'SERVICE_ERROR' : null,
    errorSummary: service.last_error,
    previewUrl: service.external_url ?? undefined,
    port: service.internal_port ?? undefined,
    durable: true,
  };
}

/** List newest Jobs and all non-expired Services under one Project-scoped contract. */
export async function listWorkbenchProcesses(projectId: string, limit = 20): Promise<WorkbenchProcess[]> {
  const [jobs, services] = await Promise.all([
    listWorkbenchJobs(projectId, limit),
    listServices(projectId, { statusFilter: ['pending', 'running', 'stopped', 'error'] }),
  ]);
  return [
    ...jobs.map(projectWorkbenchJob),
    ...services.map(projectWorkbenchService),
  ].sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? ''))).slice(0, Math.min(Math.max(limit, 1), 100));
}

/** Inspect one opaque process handle and re-check that it belongs to this Project. */
export async function inspectWorkbenchProcess(projectId: string, handle: string): Promise<WorkbenchProcess> {
  const parsed = parseWorkbenchProcessHandle(handle);
  if (parsed.kind === 'job') {
    const job = await getWorkbenchJob(projectId, parsed.id);
    if (!job) throw new WorkbenchProcessError('PROCESS_NOT_FOUND', `Project Shell process ${handle} not found`);
    return projectWorkbenchJob(job);
  }
  const service = (await listServices(projectId, { statusFilter: ['pending', 'running', 'stopped', 'error', 'expired'] }))
    .find(candidate => candidate.id === parsed.id);
  if (!service) throw new WorkbenchProcessError('PROCESS_NOT_FOUND', `Project Shell process ${handle} not found`);
  return projectWorkbenchService(service);
}

/** Read bounded Job output or tail managed Service logs through one handle. */
export async function readWorkbenchProcessLogs(projectId: string, handle: string, tail = 100, actorUserId?: number): Promise<WorkbenchProcessLogs> {
  const process = await inspectWorkbenchProcess(projectId, handle);
  if (process.kind === 'job') {
    const job = await getWorkbenchJob(projectId, process.id);
    if (!job) throw new WorkbenchProcessError('PROCESS_NOT_FOUND', `Project Shell process ${handle} not found`);
    return {
      handle: process.handle,
      stdout: job.stdout_text ?? '',
      stderr: job.stderr_text ?? '',
      complete: ['succeeded', 'failed', 'cancelled'].includes(job.status),
    };
  }
  const stdout = actorUserId === undefined
    ? await readServiceLogs(process.id, tail)
    : await readServiceLogs(process.id, tail, actorUserId);
  return { handle: process.handle, stdout, stderr: '', complete: process.state === 'stopped' || process.state === 'failed' };
}

/** Cancel a Job or stop a Service without exposing their separate registry tools. */
export async function stopWorkbenchProcess(projectId: string, handle: string, actorUserId?: number): Promise<{ process: WorkbenchProcess; localProcessSignalled?: boolean }> {
  const process = await inspectWorkbenchProcess(projectId, handle);
  if (process.kind === 'job') {
    const job = await cancelWorkbenchJob(projectId, process.id);
    const localProcessSignalled = job.status === 'cancel_requested'
      ? job.provider_kind === 'remote-worker'
        ? requestRemoteWorkbenchJobCancel(job.id)
        : requestLocalWorkbenchJobCancel(job.id)
      : false;
    return { process: projectWorkbenchJob(job), localProcessSignalled };
  }
  if (actorUserId === undefined) await stopService(process.id);
  else await stopService(process.id, actorUserId);
  return { process: { ...process, state: 'stopped', finishedAt: new Date().toISOString() } };
}
