/**
 * Owns: Remote Worker adapter for the provider-neutral Workbench broker.
 * Public API: createRemoteWorkbenchExecutionProvider.
 *
 * Remote Worker supports immediate foreground Runs, durable Jobs, and Worker-local
 * managed Services through the same authenticated transport contract.
 */

import { randomInt } from 'node:crypto';
import type { WorkbenchExecutionProvider } from './workbench-execution-broker.js';
import { registerAndStartRemoteWorkerService } from './workbench-remote-service-registry.js';
import {
  enqueueRemoteWorkbenchJob,
  type RemoteWorkbenchWorkerTransport,
  type RemoteWorkbenchWorkspaceBridge,
} from './workbench-remote-job-runner.js';

/** Bind one allowlisted Worker transport to the common Workbench execution contract. */
export function createRemoteWorkbenchExecutionProvider(
  transport: RemoteWorkbenchWorkerTransport,
  workspaceBridge?: RemoteWorkbenchWorkspaceBridge,
  slot?: { reserved: boolean; release: () => Promise<void> },
): WorkbenchExecutionProvider {
  return {
    kind: 'remote-worker',
    async executeForeground(input) {
      const environmentKeys = Object.keys(input.env ?? {}).sort();
      try {
        const result = await transport.execute({
        spec: {
          jobId: 800_000_000 + randomInt(100_000_000),
          projectId: input.projectId,
          command: input.command,
          cwd: input.cwd,
          timeoutSec: input.timeoutSec,
          workbenchRevision: null,
          environmentKeys,
        },
        credentials: input.env,
        signal: new AbortController().signal,
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
        env: input.env,
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
