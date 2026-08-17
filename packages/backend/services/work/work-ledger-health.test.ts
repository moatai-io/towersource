import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryOneMock } = vi.hoisted(() => ({ queryOneMock: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ queryOne: queryOneMock }));

import { getWorkLedgerHealth } from './work-ledger-health.js';

describe('getWorkLedgerHealth', () => {
  beforeEach(() => queryOneMock.mockReset());

  it('reports healthy when canonical writes keep pace and completion exceeds threshold', async () => {
    const now = new Date();
    queryOneMock.mockResolvedValue({
      latest_todowrite_message_at: now,
      latest_canonical_todowrite_at: new Date(now.getTime() - 60_000),
      todowrite_messages: '10',
      metadata_snapshots: '8',
      completed_snapshots: '5',
      canonical_todowrite_records: '8',
    });

    const result = await getWorkLedgerHealth(24);
    expect(result.status).toBe('healthy');
    expect(result.freshnessLagMinutes).toBe(1);
    expect(result.completedSnapshotRate).toBe(0.625);
  });

  it('reports degraded reasons for missing canonical writes and low completion', async () => {
    queryOneMock.mockResolvedValue({
      latest_todowrite_message_at: new Date(),
      latest_canonical_todowrite_at: null,
      todowrite_messages: '10',
      metadata_snapshots: '8',
      completed_snapshots: '2',
      canonical_todowrite_records: '0',
    });

    const result = await getWorkLedgerHealth(24);
    expect(result.status).toBe('degraded');
    expect(result.reasons).toEqual(expect.arrayContaining([
      'recent_metadata_without_canonical_records',
      'canonical_write_lag_over_30m',
      'completed_snapshot_rate_below_50pct',
    ]));
    expect(result.fallbackOnlyEstimate).toBe(8);
  });
});
