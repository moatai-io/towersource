import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, reconcileCareerMock } = vi.hoisted(() => ({ queryMock: vi.fn(), reconcileCareerMock: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ query: queryMock }));
vi.mock('../agents/agent-career-promotion.js', () => ({ reconcileSessionProjectAgentCareer: reconcileCareerMock }));

import { finalizeSessionWorkLedgerRecords, upsertWorkLedgerRecord } from './work-ledger.js';

function ledgerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wl-1', run_id: 'run-1', project_id: 'project-1', session_id: 'session-1', owner_user_id: 7,
    workstream_key: 'work-1', workstream_title: 'Work 1', run_title: 'Run 1', outcome: null, note: null,
    source_type: 'manual', source_id: 'source-1', source_refs: {}, status: 'completed', artifacts: [], backlog: [],
    questions: [], todos: [], activity_at: '2026-07-31T09:00:00.000Z', started_at: '2026-07-31T09:00:00.000Z',
    completed_at: '2026-07-31T09:10:00.000Z', created_at: '2026-07-31T09:00:00.000Z', updated_at: '2026-07-31T09:10:00.000Z',
    ...overrides,
  };
}

describe('upsertWorkLedgerRecord career reconciliation', () => {
  beforeEach(() => {
    queryMock.mockReset();
    reconcileCareerMock.mockReset().mockResolvedValue(null);
  });

  it('reconciles when a record is inserted or transitions to completed', async () => {
    queryMock.mockResolvedValueOnce([ledgerRow({ became_completed: true })]);

    await upsertWorkLedgerRecord({
      runId: 'run-1', projectId: 'project-1', sessionId: 'session-1', ownerUserId: 7,
      workstreamKey: 'work-1', runTitle: 'Run 1', sourceType: 'manual', sourceId: 'source-1', status: 'completed',
    });

    expect(queryMock.mock.calls[0][0]).toContain('became_completed');
    expect(reconcileCareerMock).toHaveBeenCalledOnce();
    expect(reconcileCareerMock).toHaveBeenCalledWith('session-1');
  });

  it('does not reconcile when the same completed record is written again', async () => {
    queryMock.mockResolvedValueOnce([ledgerRow({ became_completed: false })]);

    await upsertWorkLedgerRecord({
      runId: 'run-1', projectId: 'project-1', sessionId: 'session-1', ownerUserId: 7,
      workstreamKey: 'work-1', runTitle: 'Run 1', sourceType: 'manual', sourceId: 'source-1', status: 'completed',
    });

    expect(reconcileCareerMock).not.toHaveBeenCalled();
  });

  it('keeps a completed write successful when career reconciliation fails', async () => {
    queryMock.mockResolvedValueOnce([ledgerRow({ became_completed: true })]);
    reconcileCareerMock.mockRejectedValueOnce(new Error('promotion unavailable'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(upsertWorkLedgerRecord({
      runId: 'run-1', projectId: 'project-1', sessionId: 'session-1', ownerUserId: 7,
      workstreamKey: 'work-1', runTitle: 'Run 1', sourceType: 'manual', sourceId: 'source-1', status: 'completed',
    })).resolves.toMatchObject({ id: 'wl-1', status: 'completed' });
    expect(errorSpy).toHaveBeenCalledWith('[work-ledger] Agent career reconciliation failed:', expect.any(Error));
    errorSpy.mockRestore();
  });
});

describe('finalizeSessionWorkLedgerRecords', () => {
  beforeEach(() => {
    queryMock.mockReset().mockResolvedValue([]);
    reconcileCareerMock.mockReset().mockResolvedValue(null);
  });

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
    expect(reconcileCareerMock).toHaveBeenCalledWith('session-1');
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
    expect(reconcileCareerMock).not.toHaveBeenCalled();
  });
});
