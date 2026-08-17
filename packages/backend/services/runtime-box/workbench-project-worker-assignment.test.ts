import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execute, queryOne, transaction, withClient } from '../../db/pg-repo.js';
import {
  claimProjectWorkerAssignment,
  completeProjectWorkerAssignment,
  failProjectWorkerAssignment,
  requestProjectWorkerAssignment,
} from './workbench-project-worker-assignment.js';

vi.mock('../../db/pg-repo.js', () => ({
  execute: vi.fn(), queryOne: vi.fn(), transaction: vi.fn(), withClient: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

const row = {
  project_id: 'p1', deployment_id: 'production', desired_worker_id: 'tower-prod-local-01',
  status: 'pending', attempt: 0, reason: 'new project', last_error: null, requested_by_user_id: 7,
  lease_owner: null, lease_expires_at: null, created_at: '2026-08-15', updated_at: '2026-08-15', completed_at: null,
} as const;

describe('Project Worker assignment desired state', () => {
  it('records pending placement without writing a production binding', async () => {
    vi.mocked(queryOne).mockResolvedValue(row);
    await expect(requestProjectWorkerAssignment({ projectId: 'p1', deploymentId: 'production', workerId: 'tower-prod-local-01', requestedByUserId: 7 }))
      .resolves.toMatchObject({ status: 'pending', desired_worker_id: 'tower-prod-local-01' });
    const sql = vi.mocked(queryOne).mock.calls[0][0];
    expect(sql).toContain('project_worker_assignment_desires');
    expect(sql).not.toContain('project_compute_deployment_bindings');
  });

  it('claims one retryable desire with a bounded lease', async () => {
    const db = { queryOne: vi.fn() };
    vi.mocked(transaction).mockImplementation(async fn => fn({} as any));
    vi.mocked(withClient).mockReturnValue(db as any);
    db.queryOne.mockResolvedValueOnce(row).mockResolvedValueOnce({ ...row, status: 'preparing', attempt: 1, lease_owner: 'r1' });
    await expect(claimProjectWorkerAssignment({ deploymentId: 'production', leaseSeconds: 60, owner: 'r1' }))
      .resolves.toMatchObject({ status: 'preparing', lease_owner: 'r1', attempt: 1 });
    expect(db.queryOne.mock.calls[0][0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(db.queryOne.mock.calls[0][0]).toContain("status='preparing' AND lease_expires_at<NOW()");
  });

  it('requires exact lease ownership to complete or fail', async () => {
    vi.mocked(execute).mockResolvedValueOnce({ changes: 1 }).mockResolvedValueOnce({ changes: 1 });
    await expect(completeProjectWorkerAssignment({ projectId: 'p1', deploymentId: 'production', leaseOwner: 'r1' })).resolves.toBe(true);
    await expect(failProjectWorkerAssignment({ projectId: 'p1', deploymentId: 'production', leaseOwner: 'r2', error: 'boom' })).resolves.toBe(true);
    expect(vi.mocked(execute).mock.calls[0][0]).toContain("status='preparing' AND lease_owner=$3");
    expect(vi.mocked(execute).mock.calls[1][0]).toContain("status='failed'");
  });
});
