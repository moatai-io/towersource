import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendWorkbenchJobOutput,
  claimWorkbenchJob,
  createWorkbenchJob,
  getWorkbenchJob,
  heartbeatWorkbenchJob,
  runClaimedWorkbenchJob,
} from './workbench-job-registry.js';
import {
  enqueueRemoteWorkbenchJob,
  inspectRemoteWorkbenchJob,
  requestRemoteWorkbenchJobCancel,
  shutdownRemoteWorkbenchJobRunners,
  type RemoteWorkbenchWorkerTransport,
} from './workbench-remote-job-runner.js';

vi.mock('./workbench-job-registry.js', () => ({
  appendWorkbenchJobOutput: vi.fn(), claimWorkbenchJob: vi.fn(), createWorkbenchJob: vi.fn(),
  getWorkbenchJob: vi.fn(), heartbeatWorkbenchJob: vi.fn(), runClaimedWorkbenchJob: vi.fn(),
}));

const queued = {
  id: 24, project_id: 'p', requested_by_user_id: 7, requested_by_session_id: 's',
  provider_kind: 'remote-worker', runner_kind: 'remote-worker', status: 'queued',
  command: 'python3 work/heavy.py', cwd: '/workspace', timeout_seconds: 120,
  environment_keys: [], workbench_revision: 6,
} as any;
const claimed = { ...queued, status: 'running', claim_token: 'remote-claim' } as any;

function transport(execute = vi.fn()): RemoteWorkbenchWorkerTransport {
  return { workerId: 'worker-a', execute };
}

beforeEach(() => {
  vi.clearAllMocks();
  shutdownRemoteWorkbenchJobRunners();
});

describe('Remote Workbench durable Job runner', () => {
  it('persists a remote-worker Job before asynchronous dispatch', async () => {
    vi.mocked(createWorkbenchJob).mockResolvedValue(queued);
    vi.mocked(claimWorkbenchJob).mockResolvedValue(undefined);
    await expect(enqueueRemoteWorkbenchJob({
      projectId: 'p', userId: 7, sessionId: 's', command: queued.command, transport: transport(),
    })).resolves.toBe(queued);
    expect(createWorkbenchJob).toHaveBeenCalledWith(expect.objectContaining({ providerKind: 'remote-worker' }));
    expect(claimWorkbenchJob).not.toHaveBeenCalled();
    await new Promise(resolve => setImmediate(resolve));
    expect(claimWorkbenchJob).toHaveBeenCalledWith(expect.objectContaining({ runnerId: 'remote:worker-a' }));
  });

  it('streams output and waits for worker-confirmed termination after cancellation', async () => {
    vi.mocked(createWorkbenchJob).mockResolvedValue(queued);
    vi.mocked(claimWorkbenchJob).mockResolvedValue(claimed);
    vi.mocked(heartbeatWorkbenchJob).mockResolvedValue(true);
    vi.mocked(appendWorkbenchJobOutput).mockResolvedValue(true);
    let release!: () => void;
    const execute = vi.fn(async ({ signal, onStdout }: Parameters<RemoteWorkbenchWorkerTransport['execute']>[0]) => {
      onStdout('remote 1/3\n');
      await new Promise<void>(resolve => {
        release = resolve;
        signal.addEventListener('abort', resolve, { once: true });
      });
      return {
        execResult: { exit_code: 143, stdout: 'remote 1/3\n', stderr: '', duration_ms: 20, timed_out: false, oom_killed: false, runtime_context: {} as any },
        artifacts: [],
        cancellation: { requested: true, processGroupExited: true, signal: 'SIGTERM' },
      };
    });
    vi.mocked(runClaimedWorkbenchJob).mockImplementation(async ({ run }) => {
      await run();
      return { job: claimed } as any;
    });

    await enqueueRemoteWorkbenchJob({
      projectId: 'p', userId: 7, sessionId: 's', command: queued.command, transport: transport(execute),
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(requestRemoteWorkbenchJobCancel(24)).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    release?.();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      spec: expect.objectContaining({ projectId: 'p', workbenchRevision: 6, environmentKeys: [] }),
      signal: expect.any(AbortSignal),
    }));
    expect(appendWorkbenchJobOutput).toHaveBeenCalledWith(expect.objectContaining({ stream: 'stdout', chunk: 'remote 1/3\n' }));
  });

  it('persists only Credential key names and consumes values once at dispatch', async () => {
    vi.mocked(createWorkbenchJob).mockResolvedValue({ ...queued, environment_keys: ['API_TOKEN'] });
    vi.mocked(claimWorkbenchJob).mockResolvedValue({ ...claimed, environment_keys: ['API_TOKEN'] });
    vi.mocked(heartbeatWorkbenchJob).mockResolvedValue(true);
    const execute = vi.fn(async () => ({
      execResult: { exit_code: 0, stdout: '', stderr: '', duration_ms: 1, timed_out: false, oom_killed: false, runtime_context: {} as any },
      artifacts: [], cancellation: { requested: false, processGroupExited: true },
    }));
    vi.mocked(runClaimedWorkbenchJob).mockImplementation(async ({ run }) => { await run(); return { job: claimed } as any; });
    await enqueueRemoteWorkbenchJob({
      projectId: 'p', userId: 7, sessionId: 's', command: queued.command,
      env: { API_TOKEN: 'never-persisted' }, transport: transport(execute),
    });
    expect(createWorkbenchJob).toHaveBeenCalledWith(expect.objectContaining({ env: { API_TOKEN: 'never-persisted' } }));
    await new Promise(resolve => setImmediate(resolve));
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ credentials: { API_TOKEN: 'never-persisted' } }));
  });

  it('reports remote ownership without returning the transport object', async () => {
    vi.mocked(getWorkbenchJob).mockResolvedValue(queued);
    await expect(inspectRemoteWorkbenchJob('p', 24)).resolves.toEqual({
      job: queued, ownedByThisProcess: false, workerId: undefined,
    });
  });
});
