import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveTeamAgentContext } from '../agent-workspaces/team-context.js';
import { consumeRemoteRunCredentialEnvelope, remoteRunCredentialEnvelopeCount } from '../execution/credentials/remote-run-credentials.js';
import {
  appendWorkbenchJobOutput,
  claimWorkbenchJob,
  createWorkbenchJob,
  getWorkbenchJob,
  heartbeatWorkbenchJob,
  runClaimedWorkbenchJob,
} from '../execution/jobs/job-registry.js';
import {
  enqueueRemoteWorkbenchJob,
  inspectRemoteWorkbenchJob,
  requestRemoteWorkbenchJobCancel,
  shutdownRemoteWorkbenchJobRunners,
  type RemoteWorkbenchWorkerTransport,
} from '../execution/remote-job-runner.js';

vi.mock('../execution/jobs/job-registry.js', () => ({
  appendWorkbenchJobOutput: vi.fn(), claimWorkbenchJob: vi.fn(), createWorkbenchJob: vi.fn(),
  getWorkbenchJob: vi.fn(), heartbeatWorkbenchJob: vi.fn(), runClaimedWorkbenchJob: vi.fn(),
}));

vi.mock('../agent-workspaces/team-context.js', () => ({ resolveTeamAgentContext: vi.fn() }));
vi.mock('../execution/credentials/remote-run-credentials.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../execution/credentials/remote-run-credentials.js')>();
  return { ...actual, consumeRemoteRunCredentialEnvelope: vi.fn(actual.consumeRemoteRunCredentialEnvelope) };
});

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
  vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '0');
  vi.mocked(resolveTeamAgentContext).mockReset();
  shutdownRemoteWorkbenchJobRunners();
});
afterEach(() => { shutdownRemoteWorkbenchJobRunners(); vi.unstubAllEnvs(); });

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
      spec: expect.objectContaining({ projectId: 'p', sessionId: 's', workbenchRevision: 6, environmentKeys: [] }),
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
  describe('queued current team admission before credential consumption', () => {
    const exec = { exit_code: 0, stdout: '', stderr: '', duration_ms: 1, timed_out: false, oom_killed: false, runtime_context: { runtime: 'workbench-worker' as const } };
    beforeEach(() => {
      vi.mocked(createWorkbenchJob).mockResolvedValue(queued);
      vi.mocked(claimWorkbenchJob).mockResolvedValue(claimed);
      vi.mocked(heartbeatWorkbenchJob).mockResolvedValue(true);
      vi.mocked(runClaimedWorkbenchJob).mockImplementation(async input => {
        const result = await input.run();
        return { job: { ...claimed, status: 'succeeded', exit_code: result.exit_code } };
      });
    });
    function captureFailure() {
      let failure: Error | undefined;
      vi.mocked(runClaimedWorkbenchJob).mockImplementation(async input => {
        try { const result = await input.run(); return { job: { ...claimed, status: 'succeeded', exit_code: result.exit_code } }; }
        catch (error) { failure = error as Error; return { job: { ...claimed, status: 'failed', exit_code: 1 } }; }
      });
      return () => failure;
    }
    it('rechecks claimed requester after enqueue and blocks new team membership before credentials/dispatch', async () => {
      vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '1');
      const failure = captureFailure();
      let current: { userId: number; agentProjectId: string; teamId: string } | null = null;
      vi.mocked(resolveTeamAgentContext).mockImplementation(async () => current);
      const transport = { workerId: 'w1', execute: vi.fn(async () => ({ execResult: exec, artifacts: [] })) };
      await enqueueRemoteWorkbenchJob({ projectId: 'p', userId: 7, sessionId: queued.requested_by_session_id,
        command: 'pwd', transport, env: { OPENAI_API_KEY: 'synthetic-test-value' } });
      // Scheduled run was teamless at enqueue; current team assignment wins.
      current = { userId: 7, agentProjectId: 'p', teamId: 'team-a' };
      await vi.waitFor(() => expect(failure()?.message).toBe('TEAM_EXECUTOR_NOT_READY'));
      expect(resolveTeamAgentContext).toHaveBeenCalledWith({ userId: claimed.requested_by_user_id, agentProjectId: claimed.project_id });
      expect(resolveTeamAgentContext).toHaveBeenCalledTimes(1);
      expect(consumeRemoteRunCredentialEnvelope).not.toHaveBeenCalled();
      expect(transport.execute).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(remoteRunCredentialEnvelopeCount()).toBe(0));
    });
    it.each(['TEAM_WORKSPACE_ACCESS_DENIED', 'TEAM_WORKSPACE_SCHEMA_UNAVAILABLE'])('propagates current team rejection %s without credential consumption or fallback', async message => {
      vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '1');
      const failure = captureFailure();
      let dispatchFailure: string | undefined;
      vi.mocked(resolveTeamAgentContext).mockImplementation(async () => {
        if (dispatchFailure) throw new Error(dispatchFailure);
        return null;
      });
      const transport = { workerId: 'w1', execute: vi.fn(async () => ({ execResult: exec, artifacts: [] })) };
      await enqueueRemoteWorkbenchJob({ projectId: 'p', userId: 7, sessionId: queued.requested_by_session_id,
        command: 'pwd', transport, env: { OPENAI_API_KEY: 'synthetic-test-value' } });
      dispatchFailure = message;
      await vi.waitFor(() => expect(failure()?.message).toBe(message));
      expect(consumeRemoteRunCredentialEnvelope).not.toHaveBeenCalled();
      expect(transport.execute).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(remoteRunCredentialEnvelopeCount()).toBe(0));
    });
    it('preserves confirmed teamless legacy dispatch and single credential consumption', async () => {
      vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '1');
      vi.mocked(resolveTeamAgentContext).mockResolvedValue(null);
      const transport = { workerId: 'w1', execute: vi.fn(async () => ({ execResult: exec, artifacts: [] })) };
      await enqueueRemoteWorkbenchJob({ projectId: 'p', userId: 7, sessionId: queued.requested_by_session_id,
        command: 'pwd', transport, env: { OPENAI_API_KEY: 'synthetic-test-value' } });
      await vi.waitFor(() => expect(transport.execute).toHaveBeenCalledTimes(1));
      expect(resolveTeamAgentContext).toHaveBeenCalledTimes(1);
      expect(consumeRemoteRunCredentialEnvelope).toHaveBeenCalledTimes(1);
    });
    it.each(['0', 'true'])('leaves feature-off legacy dispatch unchanged (%s)', async enabled => {
      vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', enabled);
      vi.mocked(resolveTeamAgentContext).mockRejectedValue(new Error('must not query team'));
      const transport = { workerId: 'w1', execute: vi.fn(async () => ({ execResult: exec, artifacts: [] })) };
      await enqueueRemoteWorkbenchJob({ projectId: 'p', userId: 7, sessionId: queued.requested_by_session_id, command: 'pwd', transport });
      await vi.waitFor(() => expect(transport.execute).toHaveBeenCalledTimes(1));
      expect(resolveTeamAgentContext).not.toHaveBeenCalled();
    });
  });

});
