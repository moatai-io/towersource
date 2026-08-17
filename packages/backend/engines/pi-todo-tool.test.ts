import { beforeEach, describe, expect, it, vi } from 'vitest';

const { upsertWorkLedgerRecordMock } = vi.hoisted(() => ({
  upsertWorkLedgerRecordMock: vi.fn(),
}));

vi.mock('../services/work/work-ledger.js', () => ({
  upsertWorkLedgerRecord: upsertWorkLedgerRecordMock,
}));

import { createTodoWriteTool } from './pi-todo-tool.js';

const work = {
  mode: 'new' as const,
  workstreamKey: 'tower-work-ledger',
  workstreamTitle: 'Tower Work Ledger',
  runTitle: 'TodoWrite canonical upsert',
  outcome: 'Canonical row is updated',
  note: 'Test note',
};

const runningTodos = [
  { content: 'Implement upsert', activeForm: 'Implementing upsert', status: 'in_progress' },
  { content: 'Verify upsert', activeForm: 'Verifying upsert', status: 'pending' },
];

const completedTodos = runningTodos.map((todo) => ({ ...todo, status: 'completed' }));

describe('TodoWrite WorkLedger integration', () => {
  beforeEach(() => {
    upsertWorkLedgerRecordMock.mockReset();
    upsertWorkLedgerRecordMock.mockResolvedValue({ id: 'wl-1' });
  });

  it('upserts one canonical run across running and completed snapshots', async () => {
    const tool = createTodoWriteTool({ sessionId: 's1', projectId: 'p1', userId: 7 });

    await tool.execute('call-1', { work, todos: runningTodos });
    await tool.execute('call-2', {
      work: { ...work, mode: 'continue', continuationOf: work.workstreamKey },
      todos: completedTodos,
      backlog: [{ type: 'test', title: 'Backfill old TodoWrite runs' }],
      questions: [{ title: 'How long should fallback remain?', status: 'open' }],
    });

    expect(upsertWorkLedgerRecordMock).toHaveBeenCalledTimes(2);
    const first = upsertWorkLedgerRecordMock.mock.calls[0][0];
    const second = upsertWorkLedgerRecordMock.mock.calls[1][0];
    expect(first).toMatchObject({
      runId: 's1:todowrite:call-1',
      sourceType: 'todowrite',
      sourceId: 'call-1',
      status: 'running',
      sessionId: 's1',
      projectId: 'p1',
      ownerUserId: 7,
      workstreamKey: work.workstreamKey,
      runTitle: work.runTitle,
    });
    expect(second).toMatchObject({
      runId: first.runId,
      sourceId: first.sourceId,
      status: 'completed',
      backlog: [{ type: 'test', title: 'Backfill old TodoWrite runs' }],
      questions: [{ title: 'How long should fallback remain?', status: 'open' }],
      sourceRefs: {
        firstTodoWriteToolCallId: 'call-1',
        latestTodoWriteToolCallId: 'call-2',
        mode: 'continue',
        continuationOf: work.workstreamKey,
      },
    });
  });

  it('keeps checklist updates working without ledger metadata', async () => {
    const tool = createTodoWriteTool({ sessionId: 's1', projectId: 'p1', userId: 7 });
    const result = await tool.execute('call-1', { todos: runningTodos });

    expect(upsertWorkLedgerRecordMock).not.toHaveBeenCalled();
    expect((result as any).content[0].text).toContain('Todo list updated: 0/2 completed');
  });

  it('reports but does not fail the checklist when ledger persistence fails', async () => {
    upsertWorkLedgerRecordMock.mockRejectedValueOnce(new Error('database unavailable'));
    const tool = createTodoWriteTool({ sessionId: 's1', projectId: 'p1', userId: 7 });

    const result = await tool.execute('call-1', { work, todos: runningTodos });

    expect((result as any).content[0].text).toContain('WorkLedger update failed: database unavailable');
  });
});
