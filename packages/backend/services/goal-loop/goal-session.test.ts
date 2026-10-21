import { describe, it, expect } from 'vitest';
import { createGoalSession, type GoalRecord, type GoalStore } from './goal-session';
const scope = { userId: 1, projectId: 'p', sessionId: 's', rootTurnId: 'r' };
function fixture() {
  let record: GoalRecord | null = null;
  const store: GoalStore = { async transact(_scope, fn) { const next = fn(record); record = structuredClone(next.record); return next.result; } };
  return { session: createGoalSession(scope, store), store };
}
const start = { requestId: 'start', expectedVersion: 0, command: { action: 'start', goal: 'fix', criteria: [{ id: 'a', description: 'test passes' }] } };
describe('goal session command boundary', () => {
  it('starts and rejects injected ownership', async () => {
    const f = fixture();
    await expect(f.session.execute({ ...start, userId: 2 })).rejects.toThrow();
    expect(await f.session.execute(start)).toMatchObject({ version: 1, scope });
  });
  it('deduplicates retries but rejects changed payloads', async () => {
    const f = fixture();
    const first = await f.session.execute(start);
    expect(await f.session.execute(start)).toEqual(first);
    await expect(f.session.execute({ ...start, command: { ...start.command, goal: 'other' } })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });
  it('rejects stale commands and wrong phases', async () => {
    const f = fixture(); await f.session.execute(start);
    await expect(f.session.execute({ requestId: 'x', expectedVersion: 0, command: { action: 'change', revision: 'v2' } })).rejects.toThrow('STALE_VERSION');
    await expect(f.session.execute({ requestId: 'x', expectedVersion: 1, command: { action: 'change', revision: 'v2' } })).rejects.toThrow('INVALID_PHASE');
  });
  it('rejects cross-session access', async () => {
    const f = fixture(); await f.session.execute(start);
    const other = createGoalSession({ ...scope, sessionId: 'other' }, f.store);
    await expect(other.execute(start)).rejects.toThrow('SCOPE_MISMATCH');
  });
  it('enforces full ordered cycle and current evidence', async () => {
    const f = fixture(); await f.session.execute(start);
    await f.session.execute({ requestId: 'i', expectedVersion: 1, command: { action: 'inspect', decision: 'change', reason: 'fix' } });
    await f.session.execute({ requestId: 'c', expectedVersion: 2, command: { action: 'change', revision: 'v2' } });
    const result = await f.session.execute({ requestId: 'k', expectedVersion: 3, command: { action: 'check', outcome: 'improved', evidence: [{ criterionId: 'a', revision: 'v2', reference: 'test receipt', passed: true }] } });
    expect(result.state.status).toBe('completed');
    await expect(f.session.execute({ requestId: 'reset', expectedVersion: 4, command: start.command })).rejects.toThrow('GOAL_ALREADY_EXISTS');
  });
  it('blocks continuation during approval wait', async () => {
    const f = fixture(); await f.session.execute(start);
    await f.session.execute({ requestId: 'wait', expectedVersion: 1, command: { action: 'stop', status: 'needs_input', reason: 'approval needed' } });
    await expect(f.session.execute({ requestId: 'i', expectedVersion: 2, command: { action: 'inspect', decision: 'change', reason: 'continue' } })).rejects.toThrow('GOAL_NOT_RUNNING');
  });
});
