import { describe, it, expect, vi } from 'vitest';
import { createGoalTools } from './pi-goal-tool';
import type { GoalRecord, GoalStore } from '../services/goal-loop/goal-session';
const scope = { userId: 1, projectId: 'p', sessionId: 's', rootTurnId: 'r' };
const start = { requestId: 'start', expectedVersion: 0, command: { action: 'start', goal: 'fix', criteria: [{ id: 'a', description: 'passes' }] } };
function fixture() {
  let record: GoalRecord | null = null;
  const store: GoalStore = { async transact(_scope, fn) { const next = fn(record); record = next.record; return next.result; } };
  const authority = { authorize: vi.fn(async () => true), verifyCheck: vi.fn(async () => false) };
  const tools = createGoalTools(scope, store, authority);
  const call = (name: string, input: unknown) => tools.find(t => t.name === name)!.execute('call', input as never);
  return { call, authority };
}
describe('goal tool adapter (unregistered)', () => {
  it('starts and reads status without advancing version', async () => {
    const f = fixture(); await f.call('goal_step', start);
    const a = await f.call('goal_status', {}); const b = await f.call('goal_status', {});
    expect(a).toEqual(b); expect(JSON.parse((a.content[0] as any).text).version).toBe(1);
  });
  it('rejects a model claiming evidence without trusted receipt verification', async () => {
    const f = fixture(); await f.call('goal_step', start);
    await f.call('goal_step', { requestId: 'i', expectedVersion: 1, command: { action: 'inspect', decision: 'verify', reason: 'looks done' } });
    const result = await f.call('goal_step', { requestId: 'k', expectedVersion: 2, command: { action: 'check', outcome: 'improved', evidence: [{ criterionId: 'a', revision: 'initial', reference: 'made-up', passed: true }] } });
    expect((result as any).isError).toBe(true);
    expect(JSON.parse((result.content[0] as any).text).error).toBe('GOAL_EVIDENCE_UNVERIFIED');
  });
  it('checks host authorization and never exposes scope or raw errors', async () => {
    const f = fixture(); f.authority.authorize.mockResolvedValue(false);
    const result = await f.call('goal_step', start);
    expect(JSON.parse((result.content[0] as any).text)).toEqual({ error: 'GOAL_ACTION_DENIED' });
  });
  it('does not accept caller-provided scope', async () => {
    const f = fixture();
    expect((await f.call('goal_step', { ...start, sessionId: 'victim' }) as any).isError).toBe(true);
    expect(f.authority.authorize).not.toHaveBeenCalled();
  });
});
