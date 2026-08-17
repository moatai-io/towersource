import { describe, expect, it } from 'vitest';
import { collapseTodoWriteBackfillCandidates } from './backfill-todowrite-work-ledger.js';

function candidate(at: string, status: string, runTitle = 'Run') {
  return {
    sessionId: 's1', projectId: 'p1', ownerUserId: 7, messageId: at, at: new Date(at), toolCallId: at,
    work: { workstreamKey: 'work', runTitle }, todos: [{ status }],
  };
}

describe('collapseTodoWriteBackfillCandidates', () => {
  it('keeps the latest snapshot for the same session/workstream/run', () => {
    const result = collapseTodoWriteBackfillCandidates([
      candidate('2026-07-10T00:00:00Z', 'in_progress'),
      candidate('2026-07-10T01:00:00Z', 'completed'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].todos[0].status).toBe('completed');
  });

  it('keeps different run titles separate', () => {
    const result = collapseTodoWriteBackfillCandidates([
      candidate('2026-07-10T00:00:00Z', 'completed', 'Run A'),
      candidate('2026-07-10T01:00:00Z', 'completed', 'Run B'),
    ]);
    expect(result).toHaveLength(2);
  });
});
