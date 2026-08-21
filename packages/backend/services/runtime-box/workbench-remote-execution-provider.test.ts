import { describe, expect, it, vi } from 'vitest';
import { createRemoteWorkbenchExecutionProvider } from './workbench-remote-execution-provider.js';

const execResult = {
  exit_code: 0,
  stdout: 'worker-foreground\n',
  stderr: '',
  duration_ms: 3,
  timed_out: false,
  oom_killed: false,
  runtime_context: { project_id: 'p' },
} as any;

describe('Remote Workbench execution provider', () => {
  it('executes foreground through the authenticated Worker transport without creating a durable Job', async () => {
    const execute = vi.fn().mockResolvedValue({ execResult, artifacts: [], cancellation: { requested: false, processGroupExited: true } });
    const provider = createRemoteWorkbenchExecutionProvider({ workerId: 'worker-a', execute });
    await expect(provider.executeForeground({
      projectId: 'p', userId: 7, sessionId: 's', command: 'pwd', cwd: '/workspace', timeoutSec: 10, env: { API_TOKEN: 'hidden' },
    })).resolves.toBe(execResult);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      spec: expect.objectContaining({ projectId: 'p', sessionId: 's', command: 'pwd', cwd: '/workspace', timeoutSec: 10, environmentKeys: ['API_TOKEN'] }),
      credentials: { API_TOKEN: 'hidden' },
    }));
  });

  it('releases a reserved foreground slot exactly once on success or transport failure', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const success = createRemoteWorkbenchExecutionProvider({
      workerId: 'worker-a', execute: vi.fn().mockResolvedValue({ execResult, artifacts: [], cancellation: { requested: false, processGroupExited: true } }),
    }, undefined, { reserved: true, release });
    await success.executeForeground({ projectId: 'p', userId: 7, sessionId: 's', command: 'pwd' });
    expect(release).toHaveBeenCalledTimes(1);

    release.mockClear();
    const failed = createRemoteWorkbenchExecutionProvider({
      workerId: 'worker-a', execute: vi.fn().mockRejectedValue(new Error('transport down')),
    }, undefined, { reserved: true, release });
    await expect(failed.executeForeground({ projectId: 'p', userId: 7, sessionId: 's', command: 'pwd' })).rejects.toThrow('transport down');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
