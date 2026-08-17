import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execute, query, queryOne } from '../../db/pg-repo.js';
import { appendWorkbenchJobOutput, cancelWorkbenchJob, claimWorkbenchJob, createWorkbenchJob, heartbeatWorkbenchJob, listWorkbenchJobs, reconcileStaleWorkbenchJobs, runClaimedWorkbenchJob } from './workbench-job-registry.js';

vi.mock('../../db/pg-repo.js', () => ({ queryOne: vi.fn(), query: vi.fn(), execute: vi.fn() }));

const row = (overrides: Record<string, unknown> = {}) => ({
  id: '12', project_id: 'p', box_id: null, requested_by_user_id: 7, requested_by_session_id: 's',
  provider_kind: 'local-runtime', runner_kind: 'local-process', status: 'queued', command: 'npm test', cwd: null,
  timeout_seconds: 30, environment_keys: ['TOKEN'], workbench_revision: 6, exit_code: null, stdout_text: null,
  stderr_text: null, result_json: null, error_code: null, error_summary: null, cancel_requested_at: null,
  started_at: null, finished_at: null, created_at: 'now', updated_at: 'now', claim_token: null, runner_id: null,
  heartbeat_at: null, lease_expires_at: null, attempt: 0, ...overrides,
});

beforeEach(() => vi.clearAllMocks());

describe('Workbench durable Job registry', () => {
  it('creates queued Job with sorted environment key names and no values', async () => {
    vi.mocked(queryOne).mockResolvedValue(row());
    const created = await createWorkbenchJob({ projectId: 'p', userId: 7, sessionId: 's', command: 'npm test', timeoutSec: 30, env: { Z: 'secret-z', A: 'secret-a' } });
    expect(created).toMatchObject({ id: 12, status: 'queued', workbench_revision: 6, environment_keys: ['TOKEN'] });
    expect(vi.mocked(queryOne).mock.calls[0][1]?.[8]).toBe(JSON.stringify(['A', 'Z']));
    expect(JSON.stringify(vi.mocked(queryOne).mock.calls[0])).not.toContain('secret-a');
  });

  it('claims, runs, and persists a succeeded terminal result', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(row({ status: 'running', claim_token: 'claim', runner_id: 'runner', attempt: 1 }));
    const claimed = await claimWorkbenchJob({ jobId: 12, projectId: 'p', runnerId: 'runner' });
    vi.mocked(queryOne)
      .mockResolvedValueOnce(row({ status: 'running', claim_token: 'claim' }))
      .mockResolvedValueOnce(row({ status: 'succeeded', claim_token: 'claim', exit_code: 0, stdout_text: 'ok', finished_at: 'later' }));
    const result = await runClaimedWorkbenchJob({ job: claimed!, run: async () => ({ exit_code: 0, stdout: 'ok', stderr: '', duration_ms: 3, timed_out: false, oom_killed: false, runtime_context: {} as any }) });
    expect(result.job).toMatchObject({ id: 12, status: 'succeeded', exit_code: 0 });
  });

  it('turns a running cancel request into cancelled after runner returns', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(row({ status: 'cancel_requested', claim_token: 'claim' }))
      .mockResolvedValueOnce(row({ status: 'cancelled', claim_token: 'claim', exit_code: 0 }));
    const result = await runClaimedWorkbenchJob({ job: row({ status: 'running', claim_token: 'claim' }) as any, run: async () => ({ exit_code: 0, stdout: '', stderr: '', duration_ms: 3, timed_out: false, oom_killed: false, runtime_context: {} as any }) });
    expect(result.job.status).toBe('cancelled');
  });

  it('persists live output only for the owned active claim', async () => {
    vi.mocked(execute).mockResolvedValue({ changes: 1 });
    expect(await appendWorkbenchJobOutput({ jobId: 12, projectId: 'p', claimToken: 'claim', stream: 'stdout', chunk: 'progress 2/18\n' })).toBe(true);
    expect(vi.mocked(execute).mock.calls[0][0]).toContain("stdout_text=LEFT(COALESCE(stdout_text,'') || $4,$5)");
    expect(vi.mocked(execute).mock.calls[0][0]).toContain("status IN ('running','cancel_requested')");
    expect(vi.mocked(execute).mock.calls[0][1]).toEqual([12, 'p', 'claim', 'progress 2/18\n', 200_000]);
  });

  it('heartbeats only the owned claim and reconciles expired leases fail-closed', async () => {
    vi.mocked(execute).mockResolvedValueOnce({ changes: 1 }).mockResolvedValueOnce({ changes: 2 });
    expect(await heartbeatWorkbenchJob({ jobId: 12, projectId: 'p', claimToken: 'claim' })).toBe(true);
    expect(await reconcileStaleWorkbenchJobs()).toBe(2);
    expect(vi.mocked(execute).mock.calls[1][0]).toContain("error_code='RUNNER_LEASE_EXPIRED'");
    expect(vi.mocked(execute).mock.calls[1][0]).not.toContain("status='queued'");
  });

  it('cancels queued Job immediately and lists newest rows with bounded limit', async () => {
    vi.mocked(queryOne).mockResolvedValue(row({ status: 'cancelled', cancel_requested_at: 'now', finished_at: 'now' }));
    expect(await cancelWorkbenchJob('p', 12)).toMatchObject({ status: 'cancelled' });
    vi.mocked(query).mockResolvedValue([row()]);
    expect(await listWorkbenchJobs('p', 500)).toHaveLength(1);
    expect(vi.mocked(query).mock.calls[0][1]).toEqual(['p', 100]);
  });

  it('records runner failure without rethrowing after durable row exists', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(row({ status: 'failed', claim_token: 'claim', error_code: 'RUNNER_ERROR', error_summary: 'boom' }));
    vi.mocked(execute).mockResolvedValue({ changes: 1 });
    const result = await runClaimedWorkbenchJob({ job: row({ status: 'running', claim_token: 'claim' }) as any, run: async () => { throw new Error('boom'); } });
    expect(result.job).toMatchObject({ status: 'failed', error_code: 'RUNNER_ERROR' });
  });
});
