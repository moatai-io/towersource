import { describe, expect, it, vi } from 'vitest';
import { createRemoteWorkbenchRsyncBridge } from './workbench-remote-rsync-bridge.js';

vi.mock('./workbench-remote-workspace-sync.js', () => ({
  snapshotWorkspace: vi.fn(async projectRoot => ({ projectRoot, files: {} })),
  applyRemoteWorkspaceDelta: vi.fn(async () => ({ applied: [], unchanged: [], conflicts: [] })),
}));

describe('Remote Workbench rsync bridge', () => {
  it('prepares an isolated Job workspace and removes it after finalization', async () => {
    const calls: Array<[string, string[]]> = [];
    const bridge = createRemoteWorkbenchRsyncBridge({
      projectId: 'p', projectRoot: '/tower/project', remote: 'worker', remoteProjectRoot: '/worker/project', sshKeyPath: '/key',
      runFileImpl: (async (file: string, args: string[]) => { calls.push([file, args]); return { stdout: '', stderr: '' } as any; }) as any,
    });
    const prepared = await bridge.prepare({ jobId: 31, projectId: 'p' });
    expect(prepared.workspaceId).toBe('job-31');
    expect(calls[0]).toEqual(['ssh', expect.arrayContaining(['worker', "rm -rf -- '/worker/project/.tower-remote-jobs/job-31' && mkdir -p -- '/worker/project/.tower-remote-jobs/job-31'"])]);
    expect(calls[1][0]).toBe('rsync');
    expect(calls[1][1]).toEqual(expect.arrayContaining(['--exclude', '.tower/', '/tower/project/', 'worker:/worker/project/.tower-remote-jobs/job-31/']));
    await prepared.finalize(false);
    expect(calls.at(-1)).toEqual(['ssh', expect.arrayContaining(['worker', "rm -rf -- '/worker/project/.tower-remote-jobs/job-31'"])]);
  });

  it('rejects any Project other than the fixed bridge Project', async () => {
    const bridge = createRemoteWorkbenchRsyncBridge({
      projectId: 'p', projectRoot: '/tower/project', remote: 'worker', remoteProjectRoot: '/worker/project', sshKeyPath: '/key',
      runFileImpl: vi.fn() as any,
    });
    await expect(bridge.prepare({ jobId: 31, projectId: 'other' })).rejects.toThrow('REMOTE_WORKSPACE_PROJECT_NOT_ALLOWED');
  });
});
