import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execInBox, getOrCreateBox } from './runtime-box-manager.js';
import { claimWorkbenchJob, createWorkbenchJob, getWorkbenchJob, heartbeatWorkbenchJob, runClaimedWorkbenchJob } from './workbench-job-registry.js';
import { enqueueLocalWorkbenchJob, inspectLocalWorkbenchJob, requestLocalWorkbenchJobCancel, shutdownLocalWorkbenchJobRunners } from './workbench-job-runner.js';

vi.mock('./runtime-box-manager.js', () => ({ getOrCreateBox: vi.fn(), execInBox: vi.fn() }));
vi.mock('./workbench-job-registry.js', () => ({
  createWorkbenchJob: vi.fn(), claimWorkbenchJob: vi.fn(), heartbeatWorkbenchJob: vi.fn(),
  runClaimedWorkbenchJob: vi.fn(), getWorkbenchJob: vi.fn(),
}));

const queued = { id: 4, project_id: 'p', requested_by_user_id: 7, requested_by_session_id: 's', command: 'npm test', cwd: null, timeout_seconds: 60 } as any;
const claimed = { ...queued, status: 'running', claim_token: 'claim' } as any;

beforeEach(() => {
  vi.clearAllMocks();
  shutdownLocalWorkbenchJobRunners();
});

describe('Local Workbench background Job runner', () => {
  it('returns queued handle before background claim and execution', async () => {
    vi.mocked(createWorkbenchJob).mockResolvedValue(queued);
    vi.mocked(claimWorkbenchJob).mockResolvedValue(undefined);
    await expect(enqueueLocalWorkbenchJob({ projectId: 'p', userId: 7, sessionId: 's', command: 'npm test' })).resolves.toBe(queued);
    expect(claimWorkbenchJob).not.toHaveBeenCalled();
    await new Promise(resolve => setImmediate(resolve));
    expect(claimWorkbenchJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 4, runnerId: expect.stringContaining('tower-local-') }));
  });

  it('passes an AbortSignal to exec and signals hard cancellation for owned Job', async () => {
    vi.mocked(createWorkbenchJob).mockResolvedValue(queued);
    vi.mocked(claimWorkbenchJob).mockResolvedValue(claimed);
    vi.mocked(getOrCreateBox).mockResolvedValue({ id: 9 } as any);
    vi.mocked(heartbeatWorkbenchJob).mockResolvedValue(true);
    let release!: () => void;
    vi.mocked(runClaimedWorkbenchJob).mockImplementation(async ({ run }) => {
      await run();
      return { job: claimed } as any;
    });
    vi.mocked(execInBox).mockImplementation(async req => {
      expect(req.signal).toBeInstanceOf(AbortSignal);
      await new Promise<void>(resolve => {
        release = resolve;
        req.signal!.addEventListener('abort', resolve, { once: true });
      });
      return { exit_code: 143, stdout: '', stderr: '', duration_ms: 1, timed_out: false, oom_killed: false, runtime_context: {} as any };
    });
    await enqueueLocalWorkbenchJob({ projectId: 'p', userId: 7, sessionId: 's', command: 'npm test', env: { TOKEN: 'ephemeral' } });
    await new Promise(resolve => setImmediate(resolve));
    expect(requestLocalWorkbenchJobCancel(4)).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    release?.();
    expect(execInBox).toHaveBeenCalledWith(expect.objectContaining({ env: { TOKEN: 'ephemeral' }, signal: expect.any(AbortSignal) }));
  });

  it('reports ownership without exposing process handles', async () => {
    vi.mocked(getWorkbenchJob).mockResolvedValue(queued);
    await expect(inspectLocalWorkbenchJob('p', 4)).resolves.toEqual({ job: queued, ownedByThisProcess: false });
  });
});
