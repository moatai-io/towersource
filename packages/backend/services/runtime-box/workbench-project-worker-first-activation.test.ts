import { beforeEach, describe, expect, it, vi } from 'vitest';
import { transaction } from '../../db/pg-repo.js';
import { activateProjectWorkerFirst, activateProjectWorkerFirstWithClient } from './workbench-project-worker-first-activation.js';

vi.mock('../../db/pg-repo.js', () => ({ transaction: vi.fn() }));

const input = {
  projectId: 'project-a',
  deploymentId: 'production',
  workerId: 'worker-a',
  actorUserId: 7,
  rolloutCohort: 'customer-worker-first',
  reason: 'Worker direct smoke passed',
};

beforeEach(() => vi.clearAllMocks());

describe('Project Worker-first activation', () => {
  it('writes settings, deployment binding, and rollout through one client', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }) } as any;
    await expect(activateProjectWorkerFirstWithClient(client, input)).resolves.toMatchObject({
      projectId: 'project-a', deploymentId: 'production', workerId: 'worker-a',
      workstationMode: true, authorityMode: 'project', rolloutStatus: 'enabled',
    });
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query.mock.calls[0][0]).toContain('project_compute_settings');
    expect(client.query.mock.calls[1][0]).toContain('project_compute_deployment_bindings');
    expect(client.query.mock.calls[2][0]).toContain('runtime_box_workbench_rollouts');
    expect(client.query.mock.calls[2][0]).toContain("status='enabled'");
  });

  it('uses the shared transaction wrapper for standalone activation', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }) } as any;
    vi.mocked(transaction).mockImplementation(async fn => fn(client));
    await activateProjectWorkerFirst(input);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledTimes(3);
  });

  it('stops before any write when required activation evidence is missing', async () => {
    const client = { query: vi.fn() } as any;
    await expect(activateProjectWorkerFirstWithClient(client, { ...input, reason: ' ' }))
      .rejects.toThrow('WORKER_FIRST_ACTIVATION_REASON_REQUIRED');
    expect(client.query).not.toHaveBeenCalled();
  });

  it('propagates a write failure so the caller transaction can roll back all records', async () => {
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockRejectedValueOnce(new Error('binding failed')) } as any;
    await expect(activateProjectWorkerFirstWithClient(client, input)).rejects.toThrow('binding failed');
    expect(client.query).toHaveBeenCalledTimes(2);
  });
});
