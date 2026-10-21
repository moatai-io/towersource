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
  fileAuthorityReady: true,
  verificationEvidence: 'worker-file-roundtrip' as const,
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
    expect(client.query.mock.calls[0][1]).toEqual(['project-a', 'worker-a', 'project', 7, true]);
    expect(client.query.mock.calls[1][0]).toContain('project_compute_deployment_bindings');
    expect(client.query.mock.calls[2][0]).toContain('runtime_box_workbench_rollouts');
    expect(client.query.mock.calls[2][0]).toContain("status='enabled'");
  });

  it('keeps host file authority when execution uses signed grants', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }) } as any;
    await activateProjectWorkerFirstWithClient(client, { ...input, fileAuthorityReady: false });
    expect(client.query.mock.calls[0][1]).toEqual(['project-a', 'worker-a', 'project', 7, false]);
    expect(client.query.mock.calls[1][1]).toEqual(['project-a', 'production', 'worker-a', 'project', 7]);
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
    await expect(activateProjectWorkerFirstWithClient(client, { ...input, verificationEvidence: undefined as any }))
      .rejects.toThrow('WORKER_FIRST_ACTIVATION_VERIFICATION_REQUIRED');
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

describe('automatic assignment insert-only binding', () => {
  it('refuses an existing binding before changing settings or rollout', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
    await expect(activateProjectWorkerFirstWithClient(client, { ...input, requireUnbound: true }))
      .rejects.toThrow('ASSIGNMENT_EXISTING_BINDING_REQUIRES_EXPLICIT_CHANGE');
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][0]).toContain('DO NOTHING RETURNING project_id');
  });
  it('inserts an absent binding once and then updates companion records', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ project_id: input.projectId }] }) } as any;
    await activateProjectWorkerFirstWithClient(client, { ...input, requireUnbound: true });
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query.mock.calls[1][0]).toContain('project_compute_settings');
    expect(client.query.mock.calls[2][0]).toContain('runtime_box_workbench_rollouts');
    expect(client.query.mock.calls.filter(([sql]: [string]) => sql.includes('INSERT INTO project_compute_deployment_bindings'))).toHaveLength(1);
  });
});
