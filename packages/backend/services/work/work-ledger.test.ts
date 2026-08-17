import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ query: queryMock }));

import { finalizeSessionWorkLedgerRecords } from './work-ledger.js';

describe('finalizeSessionWorkLedgerRecords', () => {
  beforeEach(() => queryMock.mockReset().mockResolvedValue([]));

  it('completes only current-turn running rows whose todos are all completed', async () => {
    queryMock.mockResolvedValueOnce([{ id: 'wl-1' }]);

    const count = await finalizeSessionWorkLedgerRecords({
      sessionId: 'session-1',
      turnStartedAt: '2026-07-31T09:00:00.000Z',
      outcome: 'completed',
      completedAt: '2026-07-31T09:10:00.000Z',
    });

    expect(count).toBe(1);
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("jsonb_array_length(todos) > 0"), [
      'session-1', '2026-07-31T09:00:00.000Z', 'completed', '2026-07-31T09:10:00.000Z',
    ]);
    expect(queryMock.mock.calls[0][0]).toContain("activity_at >= $2::timestamptz");
    expect(queryMock.mock.calls[0][0]).toContain("status = 'running'");
    expect(queryMock.mock.calls[0][0]).toContain("todo->>'status'");
  });

  it('marks every current-turn running row failed after an error terminal outcome', async () => {
    queryMock.mockResolvedValueOnce([{ id: 'wl-1' }, { id: 'wl-2' }]);

    const count = await finalizeSessionWorkLedgerRecords({
      sessionId: 'session-1',
      turnStartedAt: '2026-07-31T09:00:00.000Z',
      outcome: 'failed',
    });

    expect(count).toBe(2);
    expect(queryMock.mock.calls[0][0]).toContain('AND (TRUE)');
    expect(queryMock.mock.calls[0][1]).toEqual([
      'session-1', '2026-07-31T09:00:00.000Z', 'failed', expect.any(String),
    ]);
  });
});
