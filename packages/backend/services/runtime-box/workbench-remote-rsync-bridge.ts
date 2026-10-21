/**
 * Owns: Operator-only rsync bridge for the single-project Remote Worker dogfood.
 * Public API: createRemoteWorkbenchRsyncBridge.
 *
 * This is an explicit prototype adapter, not a general transport. It creates a per-Job
 * remote workspace, stages output locally, and delegates conflict-safe materialization.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RemoteWorkbenchWorkspaceBridge } from '../execution/remote-job-runner.js';
import { applyRemoteWorkspaceDelta, snapshotWorkspace } from './workbench-remote-workspace-sync.js';

const runFile = promisify(execFile);
const RSYNC_EXCLUDES = ['.git/', '.tower/', '.project/', 'node_modules/'];

export interface RemoteWorkbenchRsyncBridgeOptions {
  projectId: string;
  projectRoot: string;
  remote: string;
  remoteProjectRoot: string;
  sshKeyPath: string;
  runFileImpl?: typeof runFile;
}

/** Build the narrow per-Job workspace bridge used by the single iwinv dogfood Project. */
export function createRemoteWorkbenchRsyncBridge(options: RemoteWorkbenchRsyncBridgeOptions): RemoteWorkbenchWorkspaceBridge {
  const execute = options.runFileImpl ?? runFile;
  const ssh = `ssh -i ${options.sshKeyPath} -o BatchMode=yes -o StrictHostKeyChecking=yes`;
  const assertProject = (projectId: string) => {
    if (projectId !== options.projectId) throw new Error('REMOTE_WORKSPACE_PROJECT_NOT_ALLOWED');
  };
  return {
    async prepare({ jobId, projectId }) {
      assertProject(projectId);
      const workspaceId = `job-${jobId}`;
      const remoteWorkspace = `${options.remoteProjectRoot}/.tower-remote-jobs/${workspaceId}`;
      const snapshot = await snapshotWorkspace(options.projectRoot);
      await execute('ssh', ['-i', options.sshKeyPath, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', options.remote,
        `rm -rf -- '${remoteWorkspace}' && mkdir -p -- '${remoteWorkspace}'`]);
      const args = ['-az', '--delete', ...RSYNC_EXCLUDES.flatMap(value => ['--exclude', value]), '-e', ssh,
        `${path.resolve(options.projectRoot)}/`, `${options.remote}:${remoteWorkspace}/`];
      await execute('rsync', args);
      return {
        workspaceId,
        async finalize(success: boolean) {
          const stagedRoot = await fs.mkdtemp(path.join(os.tmpdir(), `tower-remote-job-${jobId}-`));
          try {
            if (success) {
              await execute('rsync', ['-az', '--delete', ...RSYNC_EXCLUDES.flatMap(value => ['--exclude', value]), '-e', ssh,
                `${options.remote}:${remoteWorkspace}/`, `${stagedRoot}/`]);
              await applyRemoteWorkspaceDelta({ snapshot, stagedRoot });
            }
          } finally {
            await fs.rm(stagedRoot, { recursive: true, force: true });
            await execute('ssh', ['-i', options.sshKeyPath, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', options.remote,
              `rm -rf -- '${remoteWorkspace}'`]).catch(() => {});
          }
        },
      };
    },
  };
}
