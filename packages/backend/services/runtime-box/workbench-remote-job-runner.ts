/**
 * Owns: Durable Workbench Job lifecycle over a remote Worker transport.
 * Public API: enqueueRemoteWorkbenchJob, requestRemoteWorkbenchJobCancel,
 *             shutdownRemoteWorkbenchJobRunners, RemoteWorkbenchWorkerTransport.
 *
 * This module deliberately owns no endpoint discovery or credentials. A caller supplies
 * one allowlisted transport. Remote execution is Job-only, credential-free, lease-backed,
 * and never replayed automatically.
 */

import {
  appendWorkbenchJobOutput,
  claimWorkbenchJob,
  createWorkbenchJob,
  getWorkbenchJob,
  heartbeatWorkbenchJob,
  runClaimedWorkbenchJob,
  type WorkbenchJobRow,
} from './workbench-job-registry.js';
import type { ExecResult } from './types.js';
import {
  consumeRemoteRunCredentialEnvelope,
  discardRemoteRunCredentialEnvelope,
  issueRemoteRunCredentialEnvelope,
  type RemoteRunCredentialEnvelope,
} from './workbench-remote-run-credentials.js';

const HEARTBEAT_MS = 5_000;
const LEASE_SECONDS = 20;

export interface RemoteWorkbenchArtifactRequest {
  /** Project-relative file path. Directories and glob patterns are intentionally unsupported. */
  path: string;
}

export interface RemoteWorkbenchArtifactManifestEntry {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface RemoteWorkbenchCancellationAcknowledgement {
  requested: boolean;
  processGroupExited: boolean;
  signal?: 'SIGTERM' | 'SIGKILL';
}

export interface RemoteWorkbenchJobSpec {
  jobId: number;
  projectId: string;
  /** Optional operator-prepared per-Job workspace directory under the allowlisted Project root. */
  workspaceId?: string;
  command: string;
  cwd?: string;
  timeoutSec?: number;
  workbenchRevision: number | null;
  environmentKeys: string[];
  artifacts?: RemoteWorkbenchArtifactRequest[];
}

export interface RemoteWorkbenchExecutionResult {
  execResult: ExecResult;
  artifacts: RemoteWorkbenchArtifactManifestEntry[];
  cancellation: RemoteWorkbenchCancellationAcknowledgement;
}

export interface RemoteWorkbenchWorkerTransport {
  workerId: string;
  execute(input: {
    spec: RemoteWorkbenchJobSpec;
    /** Consumed once immediately before authenticated dispatch; never persisted. */
    credentials?: Record<string, string>;
    signal: AbortSignal;
    onStdout: (chunk: string) => void;
    onStderr: (chunk: string) => void;
  }): Promise<RemoteWorkbenchExecutionResult>;
}

export interface RemoteWorkbenchWorkspaceBridge {
  prepare(input: { jobId: number; projectId: string }): Promise<{ workspaceId: string; finalize(success: boolean): Promise<void> }>;
}

interface ActiveRemoteJob {
  controller: AbortController;
  transport: RemoteWorkbenchWorkerTransport;
}

const active = new Map<number, ActiveRemoteJob>();

/** Create a remote-worker Job and dispatch it asynchronously through one allowlisted transport. */
export async function enqueueRemoteWorkbenchJob(input: {
  projectId: string;
  userId: number;
  sessionId: string;
  command: string;
  cwd?: string;
  timeoutSec?: number;
  env?: Record<string, string>;
  transport: RemoteWorkbenchWorkerTransport;
  workspaceBridge?: RemoteWorkbenchWorkspaceBridge;
  onTerminal?: () => Promise<void> | void;
}): Promise<WorkbenchJobRow> {
  const job = await createWorkbenchJob({
    projectId: input.projectId,
    userId: input.userId,
    sessionId: input.sessionId,
    command: input.command,
    cwd: input.cwd,
    timeoutSec: input.timeoutSec,
    env: input.env,
    providerKind: 'remote-worker',
  });
  const credentialEnvelope = Object.keys(input.env ?? {}).length > 0
    ? issueRemoteRunCredentialEnvelope({ jobId: job.id, projectId: job.project_id, values: input.env! })
    : undefined;
  setImmediate(() => {
    void runRemoteJob(job, input.transport, input.workspaceBridge, credentialEnvelope, input.onTerminal).catch(error => {
      console.error(`[remote-workbench-job] job=${job.id} runner failure:`, (error as Error).message);
    });
  });
  return job;
}

async function runRemoteJob(
  job: WorkbenchJobRow,
  transport: RemoteWorkbenchWorkerTransport,
  workspaceBridge?: RemoteWorkbenchWorkspaceBridge,
  credentialEnvelope?: RemoteRunCredentialEnvelope,
  onTerminal?: () => Promise<void> | void,
): Promise<void> {
  const claimed = await claimWorkbenchJob({
    jobId: job.id,
    projectId: job.project_id,
    runnerId: `remote:${transport.workerId}`,
    leaseSeconds: LEASE_SECONDS,
  });
  if (!claimed?.claim_token) {
    if (credentialEnvelope) discardRemoteRunCredentialEnvelope(credentialEnvelope.envelopeId);
    return;
  }

  const controller = new AbortController();
  active.set(job.id, { controller, transport });
  const heartbeat = setInterval(() => {
    void heartbeatWorkbenchJob({
      jobId: job.id,
      projectId: job.project_id,
      claimToken: claimed.claim_token!,
      leaseSeconds: LEASE_SECONDS,
    }).then(owned => {
      if (!owned) controller.abort();
    }).catch(() => controller.abort());
  }, HEARTBEAT_MS);
  heartbeat.unref();

  let prepared: Awaited<ReturnType<RemoteWorkbenchWorkspaceBridge['prepare']>> | undefined;
  try {
    prepared = await workspaceBridge?.prepare({ jobId: job.id, projectId: job.project_id });
    await runClaimedWorkbenchJob({
      job: claimed,
      run: async () => {
        const credentials = credentialEnvelope
          ? consumeRemoteRunCredentialEnvelope({
            envelopeId: credentialEnvelope.envelopeId,
            jobId: job.id,
            projectId: job.project_id,
          })
          : undefined;
        const result = await transport.execute({
        spec: {
          jobId: job.id,
          projectId: job.project_id,
          ...(prepared ? { workspaceId: prepared.workspaceId } : {}),
          command: job.command,
          cwd: job.cwd ?? undefined,
          timeoutSec: job.timeout_seconds ?? undefined,
          workbenchRevision: job.workbench_revision,
          environmentKeys: job.environment_keys,
        },
        ...(credentials ? { credentials } : {}),
        signal: controller.signal,
        onStdout: chunk => {
          void appendWorkbenchJobOutput({
            jobId: job.id,
            projectId: job.project_id,
            claimToken: claimed.claim_token!,
            stream: 'stdout',
            chunk,
          });
        },
        onStderr: chunk => {
          void appendWorkbenchJobOutput({
            jobId: job.id,
            projectId: job.project_id,
            claimToken: claimed.claim_token!,
            stream: 'stderr',
            chunk,
          });
        },
        });
        if (prepared) await prepared.finalize(result.execResult.exit_code === 0);
        prepared = undefined;
        return result.execResult;
      },
    });
  } finally {
    if (credentialEnvelope) discardRemoteRunCredentialEnvelope(credentialEnvelope.envelopeId);
    try { await prepared?.finalize(false); }
    finally { clearInterval(heartbeat); }
    active.delete(job.id);
    await onTerminal?.();
  }
}

/** Signal the transport that owns this remote Job; stopped is recorded only after runner finalization. */
export function requestRemoteWorkbenchJobCancel(jobId: number): boolean {
  const owned = active.get(jobId);
  if (!owned) return false;
  owned.controller.abort();
  return true;
}

/** Abort in-flight transports during backend shutdown; stale leases fail closed without replay. */
export function shutdownRemoteWorkbenchJobRunners(): void {
  for (const owned of active.values()) owned.controller.abort();
  active.clear();
}

/** Test/diagnostic visibility without exposing transport internals. */
export async function inspectRemoteWorkbenchJob(
  projectId: string,
  jobId: number,
): Promise<{ job?: WorkbenchJobRow; ownedByThisProcess: boolean; workerId?: string }> {
  const owned = active.get(jobId);
  return {
    job: await getWorkbenchJob(projectId, jobId),
    ownedByThisProcess: Boolean(owned),
    workerId: owned?.transport.workerId,
  };
}
