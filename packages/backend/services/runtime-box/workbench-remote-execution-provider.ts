import { isManagedDownloadCommand } from '../execution/downloads/download-contract.js';
/**
 * Owns: Remote Worker adapter for the provider-neutral Workbench broker.
 * Public API: createRemoteWorkbenchExecutionProvider.
 *
 * Remote Worker supports immediate foreground Runs, durable Jobs, and Worker-local
 * managed Services through the same authenticated transport contract.
 */

import { randomInt } from 'node:crypto';
import type { WorkbenchExecutionProvider } from '../execution/execution-broker.js';
import { registerAndStartRemoteWorkerService } from './workbench-remote-service-registry.js';
import {
  enqueueRemoteWorkbenchJob,
  type RemoteWorkbenchWorkerTransport,
  type RemoteWorkbenchWorkspaceBridge,
} from '../execution/remote-job-runner.js';

/** Bind one allowlisted Worker transport to the common Workbench execution contract. */
export function createRemoteWorkbenchExecutionProvider(
  transport: RemoteWorkbenchWorkerTransport,
  workspaceBridge?: RemoteWorkbenchWorkspaceBridge,
  slot?: { reserved: boolean; release: () => Promise<void> },
): WorkbenchExecutionProvider {
  return {
    kind: 'remote-worker',
    async executeForeground(input) {
      // Worker-first authority travels in spec.sessionId. Mirror it into the run-scoped
      // envelope as a compatibility contract so older Workers that predate native
      // spec.sessionId materialization still expose the audit context to the process.
      const runEnv = { ...input.env, TOWER_SESSION_ID: input.sessionId };
      const environmentKeys = Object.keys(runEnv).sort();
      try {
        input.signal?.throwIfAborted();
        const result = await transport.execute({
        spec: {
          jobId: 800_000_000 + randomInt(100_000_000),
          projectId: input.projectId,
          actorUserId: input.userId,
          sessionId: input.sessionId,
          command: input.command,
          cwd: input.cwd,
          timeoutSec: input.timeoutSec,
          workbenchRevision: null,
          environmentKeys,
        },
        credentials: runEnv,
        signal: input.signal ?? new AbortController().signal,
        onStdout: () => {},
        onStderr: () => {},
        });
        return result.execResult;
      } finally {
        if (slot?.reserved) await slot.release();
      }
    },
    async enqueueJob(input) {
      return enqueueRemoteWorkbenchJob({
        projectId: input.projectId,
        userId: input.userId,
        sessionId: input.sessionId,
        command: input.command,
        cwd: input.cwd,
        timeoutSec: input.timeoutSec,
        env: isManagedDownloadCommand(input.command) ? undefined : input.env,
        transport,
        workspaceBridge,
        onTerminal: slot?.reserved ? slot.release : undefined,
      });
    },
    async startService(input) {
      return registerAndStartRemoteWorkerService({
        request: {
          boxId: 0,
          projectId: input.projectId,
          userId: input.userId,
          name: input.service.name,
          command: input.command,
          cwd: input.cwd,
          internalPort: input.service.port,
          pinned: input.service.pinned,
          purpose: input.service.purpose,
          ttlHours: input.service.ttlHours,
        },
        workerId: transport.workerId,
        transport,
      });
    },
  };
}
