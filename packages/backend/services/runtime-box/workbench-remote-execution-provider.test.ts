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
      spec: expect.objectContaining({
        projectId: 'p', sessionId: 's', command: 'pwd', cwd: '/workspace', timeoutSec: 10,
        environmentKeys: ['API_TOKEN', 'TOWER_SESSION_ID'],
      }),
      credentials: { API_TOKEN: 'hidden', TOWER_SESSION_ID: 's' },
    }));
  });

  it('mirrors the closure-bound Session into the run envelope when the caller has no env', async () => {
    const execute = vi.fn().mockResolvedValue({ execResult, artifacts: [], cancellation: { requested: false, processGroupExited: true } });
    const provider = createRemoteWorkbenchExecutionProvider({ workerId: 'worker-a', execute });

    await provider.executeForeground({ projectId: 'p', userId: 7, sessionId: 'session-a', command: 'git status' });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      spec: expect.objectContaining({ sessionId: 'session-a', environmentKeys: ['TOWER_SESSION_ID'] }),
      credentials: { TOWER_SESSION_ID: 'session-a' },
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

it('propagates broker foreground cancellation and releases the reserved slot', async () => {
  const { executeWorkbenchRequest } = await import('../execution/execution-broker.js');
  const controller = new AbortController();
  const release = vi.fn().mockResolvedValue(undefined);
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const execute = vi.fn(({ signal }) => new Promise<never>((_, reject) => {
    expect(signal).toBe(controller.signal);
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    entered();
  }));
  const provider = createRemoteWorkbenchExecutionProvider({ workerId: 'w', execute }, undefined, { reserved: true, release });
  const pending = executeWorkbenchRequest({ request: { command: 'pwd', lifecycle: 'foreground' }, context: { projectId: 'p', userId: 7, sessionId: 's', userRole: 'member', projectMember: true }, provider, signal: controller.signal });
  const assertion = expect(pending).rejects.toThrow('cancelled');
  await started;
  controller.abort();
  await assertion;
  expect(release).toHaveBeenCalledTimes(1);
});

it('does not dispatch an already cancelled foreground command and releases capacity', async () => {
  const controller = new AbortController(); controller.abort();
  const execute = vi.fn(); const release = vi.fn().mockResolvedValue(undefined);
  const provider = createRemoteWorkbenchExecutionProvider({ workerId: 'w', execute }, undefined, { reserved: true, release });
  await expect(provider.executeForeground({ projectId: 'p', userId: 7, sessionId: 's', command: 'pwd', signal: controller.signal })).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
});
