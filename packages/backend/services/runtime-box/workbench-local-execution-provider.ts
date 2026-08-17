/**
 * Owns: Local Runtime Box adapter for the provider-neutral Workbench execution broker.
 * Public API: createLocalWorkbenchExecutionProvider.
 */

import { ensureRunning, execInBox, getOrCreateBox } from './runtime-box-manager.js';
import { registerService, startServiceProcess } from './service-registry.js';
import type { WorkbenchExecutionProvider } from './workbench-execution-broker.js';
import { enqueueLocalWorkbenchJob } from './workbench-job-runner.js';

/** Reuse existing Runtime Box command and Service primitives behind one provider seam. */
export function createLocalWorkbenchExecutionProvider(): WorkbenchExecutionProvider {
  const execute = async (input: Parameters<WorkbenchExecutionProvider['executeForeground']>[0]) => {
    const box = await getOrCreateBox(input.projectId, input.userId);
    return execInBox({
      boxId: Number(box.id), userId: input.userId, sessionId: input.sessionId,
      cmd: input.command, cwd: input.cwd, timeout_sec: input.timeoutSec, env: input.env,
    });
  };
  return {
    kind: 'local-runtime',
    executeForeground: execute,
    async enqueueJob(input) {
      return enqueueLocalWorkbenchJob({
        projectId: input.projectId, userId: input.userId, sessionId: input.sessionId,
        command: input.command, cwd: input.cwd, timeoutSec: input.timeoutSec, env: input.env,
      });
    },
    async startService(input) {
      const box = await getOrCreateBox(input.projectId, input.userId);
      await ensureRunning(Number(box.id), input.userId);
      const registered = await registerService({
        boxId: Number(box.id), projectId: input.projectId, userId: input.userId,
        name: input.service.name, command: input.command, cwd: input.cwd,
        internalPort: input.service.port, pinned: input.service.pinned,
        purpose: input.service.purpose, ttlHours: input.service.ttlHours,
      });
      return startServiceProcess(Number(registered.id));
    },
  };
}
