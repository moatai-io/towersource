import { isManagedDownloadCommand } from '../execution/downloads/download-contract.js';
/**
 * Owns: In-process Local Runtime background runners for durable Workbench Jobs.
 * Public API: enqueueLocalWorkbenchJob, requestLocalWorkbenchJobCancel, shutdownLocalWorkbenchJobRunners.
 *
 * PostgreSQL owns lifecycle truth. This module owns only live AbortControllers and
 * heartbeat timers for the current backend process.
 */

import { execInBox, getOrCreateBox } from './runtime-box-manager.js';
import {
  appendWorkbenchJobOutput,
  claimWorkbenchJob,
  createWorkbenchJob,
  getWorkbenchJob,
  heartbeatWorkbenchJob,
  runClaimedWorkbenchJob,
  type WorkbenchJobRow,
} from '../execution/jobs/job-registry.js';

const RUNNER_ID = `tower-local-${process.pid}`;
const HEARTBEAT_MS = 5_000;
const LEASE_SECONDS = 20;
const active = new Map<number, AbortController>();

/** Create a durable Job row, return it immediately, and start Local execution asynchronously. */
export async function enqueueLocalWorkbenchJob(input: {
  projectId: string; userId: number; sessionId: string; command: string;
  cwd?: string; timeoutSec?: number; env?: Record<string, string>;
}): Promise<WorkbenchJobRow> {
  const job = await createWorkbenchJob(input);
  inputEnv.set(job.id, input.env);
  setImmediate(() => { void runLocalJob(job).catch(error => console.error(`[workbench-job] job=${job.id} runner failure:`, (error as Error).message)); });
  return job;
}

async function runLocalJob(job: WorkbenchJobRow): Promise<void> {
  const claimed = await claimWorkbenchJob({ jobId: job.id, projectId: job.project_id, runnerId: RUNNER_ID, leaseSeconds: LEASE_SECONDS });
  if (!claimed?.claim_token) return;
  const controller = new AbortController();
  active.set(job.id, controller);
  const heartbeat = setInterval(() => {
    void heartbeatWorkbenchJob({ jobId: job.id, projectId: job.project_id, claimToken: claimed.claim_token!, leaseSeconds: LEASE_SECONDS })
      .then(owned => { if (!owned) controller.abort(); })
      .catch(() => controller.abort());
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    await runClaimedWorkbenchJob({
      job: claimed,
      run: async () => {
        const box = await getOrCreateBox(job.project_id, job.requested_by_user_id);
        return execInBox({
          boxId: Number(box.id), userId: job.requested_by_user_id, sessionId: job.requested_by_session_id,
          cmd: job.command, cwd: job.cwd ?? undefined, timeout_sec: job.timeout_seconds ?? undefined,
          // Secret values are intentionally process-local and are not persisted in the Job row.
          env: inputEnv.get(job.id), credentialMode: isManagedDownloadCommand(job.command) ? 'none' : 'auto', signal: controller.signal,
          onStdout: chunk => { void appendWorkbenchJobOutput({ jobId: job.id, projectId: job.project_id, claimToken: claimed.claim_token!, stream: 'stdout', chunk, preserveTail: isManagedDownloadCommand(job.command) }); },
          onStderr: chunk => { void appendWorkbenchJobOutput({ jobId: job.id, projectId: job.project_id, claimToken: claimed.claim_token!, stream: 'stderr', chunk }); },
        });
      },
    });
  } finally {
    clearInterval(heartbeat);
    active.delete(job.id);
    inputEnv.delete(job.id);
  }
}

const inputEnv = new Map<number, Record<string, string> | undefined>();


/** Abort the live docker exec when this backend owns it. Registry cancellation is handled by caller. */
export function requestLocalWorkbenchJobCancel(jobId: number): boolean {
  const controller = active.get(jobId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Stop accepting process ownership during backend shutdown; leases expire fail-closed after restart. */
export function shutdownLocalWorkbenchJobRunners(): void {
  for (const controller of active.values()) controller.abort();
  active.clear();
  inputEnv.clear();
}

/** Test/diagnostic visibility without exposing process handles. */
export async function inspectLocalWorkbenchJob(projectId: string, jobId: number): Promise<{ job?: WorkbenchJobRow; ownedByThisProcess: boolean }> {
  return { job: await getWorkbenchJob(projectId, jobId), ownedByThisProcess: active.has(jobId) };
}
