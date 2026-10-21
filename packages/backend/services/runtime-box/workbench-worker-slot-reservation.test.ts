import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryOne, transaction, withClient } from '../../db/pg-repo.js';
import {
  heartbeatPersistedWorkbenchWorker,
  reapExpiredPersistedWorkbenchWorkerReservations,
  releasePersistedWorkbenchWorkerSlot,
  reservePersistedWorkbenchWorkerSlot,
} from '../execution/worker/worker-repository.js';

vi.mock('../../db/pg-repo.js', () => ({
  queryOne: vi.fn(), query: vi.fn(), execute: vi.fn(),
  transaction: vi.fn(async (fn: (client: object) => Promise<unknown>) => fn({})),
  withClient: vi.fn(),
}));

const row = {
  worker_id: 'tower-prod-local-01', base_url: 'http://127.0.0.1:43125', capabilities: ['job'], project_ids: ['p1'],
  cpu_total: 4, memory_mb_total: 8192, active_runs: 2, max_runs: 20, draining: false,
  metadata_json: { deploymentId: 'production' }, registered_at: new Date(0).toISOString(), heartbeat_at: new Date().toISOString(),
};

const db = { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(withClient).mockReturnValue(db as never);
});

describe('Workbench Worker capacity reservation ledger', () => {
  it('heartbeat updates liveness and max capacity without overwriting reserved units', async () => {
    vi.mocked(queryOne).mockResolvedValue(row);
    await heartbeatPersistedWorkbenchWorker({ workerId: row.worker_id, capacity: { cpuTotal: 4, memoryMbTotal: 8192, activeRuns: 0, maxRuns: 20 } });
    const [sql, params] = vi.mocked(queryOne).mock.calls[0];
    expect(sql).toContain("SET state='expired'");
    expect(sql).toContain('active_runs=(SELECT COALESCE(SUM(r.weight),0)');
    expect(sql).toContain('max_runs=GREATEST($4,(SELECT COALESCE(SUM(r.weight),0)');
    expect(params).toEqual([row.worker_id, 4, 8192, 20]);
  });

  it('expires stale ledger rows, locks one eligible Worker, inserts a reservation, and reconciles active_runs', async () => {
    db.queryOne.mockResolvedValueOnce(row).mockResolvedValueOnce(row);
    await expect(reservePersistedWorkbenchWorkerSlot({
      projectId: '00000000-0000-0000-0000-000000000001', deploymentId: 'production', sessionId: 'session-a',
      requiredCapabilities: ['job'], preferredWorkerId: row.worker_id, weight: 2, ttlSeconds: 900,
    })).resolves.toMatchObject({ workerId: row.worker_id, reservationId: expect.any(String), capacity: { activeRuns: 2, maxRuns: 20 } });
    expect(vi.mocked(transaction)).toHaveBeenCalledOnce();
    expect(db.execute.mock.calls[0][0]).toContain("state='expired'");
    expect(db.queryOne.mock.calls[0][0]).toContain('FOR UPDATE OF w SKIP LOCKED');
    expect(db.queryOne.mock.calls[0][0]).toContain('SUM(r.weight)');
    expect(db.queryOne.mock.calls[0][1][7]).toBe(false);
    expect(db.execute.mock.calls[1][0]).toContain('capacity_reservations');
    expect(db.execute.mock.calls[1][1].slice(1)).toEqual([row.worker_id, '00000000-0000-0000-0000-000000000001', 'session-a', 2, 900]);
    expect(db.queryOne.mock.calls[1][0]).toContain('active_runs=(SELECT COALESCE(SUM(r.weight),0)');
  });

  it('permits stale heartbeat only for the exact preferred Workstation Worker', async () => {
    db.queryOne.mockResolvedValueOnce(row).mockResolvedValueOnce(row);
    await reservePersistedWorkbenchWorkerSlot({
      projectId: '00000000-0000-0000-0000-000000000001', deploymentId: 'production',
      requiredCapabilities: ['job'], preferredWorkerId: row.worker_id, allowStalePreferredWorker: true,
    });
    const [sql, params] = db.queryOne.mock.calls[0];
    expect(sql).toContain('($8 AND w.worker_id=$4)');
    expect(params[3]).toBe(row.worker_id);
    expect(params[7]).toBe(true);
  });

  it('releases exactly one reservation and derives the counter from remaining live ledger rows', async () => {
    db.queryOne.mockResolvedValue({ worker_id: row.worker_id });
    await expect(releasePersistedWorkbenchWorkerSlot('11111111-1111-1111-1111-111111111111')).resolves.toBe(true);
    expect(db.queryOne.mock.calls[0][0]).toContain("state='released'");
    expect(db.queryOne.mock.calls[0][1]).toEqual(['11111111-1111-1111-1111-111111111111']);
    expect(db.execute.mock.calls[0][0]).toContain('SUM(r.weight)');
  });

  it('reaps expired orphan reservations and reconciles each affected Worker', async () => {
    db.query.mockResolvedValue([{ worker_id: row.worker_id }, { worker_id: row.worker_id }, { worker_id: 'worker-b' }]);
    await expect(reapExpiredPersistedWorkbenchWorkerReservations()).resolves.toBe(3);
    expect(db.query.mock.calls[0][0]).toContain("state='expired'");
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid capacity weights', async () => {
    await expect(reservePersistedWorkbenchWorkerSlot({ projectId: 'p1', deploymentId: 'production', weight: 0 }))
      .rejects.toThrow('WORKER_CAPACITY_WEIGHT_INVALID');
  });
});
