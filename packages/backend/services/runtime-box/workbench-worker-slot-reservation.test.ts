import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execute, queryOne } from '../../db/pg-repo.js';
import { heartbeatPersistedWorkbenchWorker, releasePersistedWorkbenchWorkerSlot, reservePersistedWorkbenchWorkerSlot } from './workbench-worker-repository.js';

vi.mock('../../db/pg-repo.js', () => ({ queryOne: vi.fn(), query: vi.fn(), execute: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

const row = {
  worker_id: 'tower-prod-local-01', base_url: 'http://127.0.0.1:43125', capabilities: ['job'], project_ids: ['p1'],
  cpu_total: 4, memory_mb_total: 8192, active_runs: 3, max_runs: 5, draining: false,
  metadata_json: { deploymentId: 'production' }, registered_at: new Date(0).toISOString(), heartbeat_at: new Date().toISOString(),
};

describe('Workbench Worker slot reservation', () => {
  it('heartbeat updates liveness and max capacity without overwriting reserved units', async () => {
    vi.mocked(queryOne).mockResolvedValue(row);
    await heartbeatPersistedWorkbenchWorker({ workerId: 'tower-prod-local-01', capacity: { cpuTotal: 4, memoryMbTotal: 8192, activeRuns: 0, maxRuns: 5 } });
    const [sql, params] = vi.mocked(queryOne).mock.calls[0];
    expect(sql).not.toContain('active_runs=$');
    expect(sql).toContain('max_runs=GREATEST($4,active_runs)');
    expect(params).toEqual(['tower-prod-local-01', 4, 8192, 5]);
  });

  it('selects and increments weighted capacity in one locked SQL statement', async () => {
    vi.mocked(queryOne).mockResolvedValue(row);
    await expect(reservePersistedWorkbenchWorkerSlot({
      projectId: 'p1', deploymentId: 'production', requiredCapabilities: ['job'], preferredWorkerId: 'tower-prod-local-01', weight: 2,
    })).resolves.toMatchObject({ workerId: 'tower-prod-local-01', deploymentId: 'production', capacity: { activeRuns: 3, maxRuns: 5 } });
    const [sql, params] = vi.mocked(queryOne).mock.calls[0];
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('active_runs+$6 <= max_runs');
    expect(sql).toContain('active_runs=w.active_runs+$6');
    expect(sql).toContain("metadata_json->>'deploymentId'=$5");
    expect(params).toEqual(['p1', ['job'], 15000, 'tower-prod-local-01', 'production', 2]);
  });

  it('reports capacity unavailable when no slot can be atomically reserved', async () => {
    vi.mocked(queryOne).mockResolvedValue(undefined);
    await expect(reservePersistedWorkbenchWorkerSlot({ projectId: 'p1', deploymentId: 'production' }))
      .rejects.toThrow('WORKER_CAPACITY_UNAVAILABLE');
  });

  it('returns weighted capacity without decrementing below zero', async () => {
    vi.mocked(execute).mockResolvedValue({ changes: 1 });
    await expect(releasePersistedWorkbenchWorkerSlot('tower-prod-local-01', 3)).resolves.toBe(true);
    expect(vi.mocked(execute).mock.calls[0][0]).toContain('active_runs=GREATEST(active_runs-$2,0)');
    expect(vi.mocked(execute).mock.calls[0][1]).toEqual(['tower-prod-local-01', 3]);
  });

  it('rejects invalid capacity weights', async () => {
    await expect(reservePersistedWorkbenchWorkerSlot({ projectId: 'p1', deploymentId: 'production', weight: 0 }))
      .rejects.toThrow('WORKER_CAPACITY_WEIGHT_INVALID');
    await expect(releasePersistedWorkbenchWorkerSlot('tower-prod-local-01', 0))
      .rejects.toThrow('WORKER_CAPACITY_WEIGHT_INVALID');
  });
});
