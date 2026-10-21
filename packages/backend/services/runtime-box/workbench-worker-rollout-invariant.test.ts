import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../../db/pg-repo.js';
import { assertWorkerRolloutInvariant, listWorkerRolloutInvariantDrift } from './workbench-worker-rollout-invariant.js';

vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn() }));

describe('Worker binding and rollout invariant', () => {
  beforeEach(() => vi.clearAllMocks());

  it('finds active Worker bindings without an enabled rollout', async () => {
    vi.mocked(query).mockResolvedValue([{ project_id: 'p1', project_name: 'Jules', worker_id: 'worker-a', rollout_status: null }] as any);
    await expect(listWorkerRolloutInvariantDrift()).resolves.toHaveLength(1);
    expect(vi.mocked(query).mock.calls[0][0]).toContain("COALESCE(r.status,'disabled') <> 'enabled'");
    expect(vi.mocked(query).mock.calls[0][0]).toContain('b.workstation_mode=TRUE');
    expect(vi.mocked(query).mock.calls[0][1]).toEqual(['production']);
  });

  it('passes when every Worker-bound Project has an enabled rollout', async () => {
    vi.mocked(query).mockResolvedValue([]);
    await expect(assertWorkerRolloutInvariant()).resolves.toBeUndefined();
  });

  it('fails closed with bounded actionable drift evidence', async () => {
    vi.mocked(query).mockResolvedValue([
      { project_id: 'p1', project_name: 'Jules', worker_id: 'worker-a', rollout_status: null },
      { project_id: 'p2', project_name: 'General', worker_id: 'worker-a', rollout_status: 'disabled' },
    ] as any);
    await expect(assertWorkerRolloutInvariant()).rejects.toThrow('WORKER_ROLLOUT_INVARIANT_VIOLATION: 2');
  });
});
