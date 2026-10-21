import { describe, expect, it } from 'vitest';
import { startGoal } from './goal-loop';
import { createGoalManager, decideGoalSettlement, type GoalManagerSnapshot } from './goal-manager';
function snapshot(): GoalManagerSnapshot {
  return { goal: { id: 'persistent-goal', userId: 1, projectId: 'p', sessionId: 's', version: 3,
    state: startGoal('fix', [{ id: 'test', description: 'passes' }]),
    activeExecution: { rootTurnId: 'turn-2', startProgressVersion: 1 }, progressVersion: 2,
    dispatched: 2, maxExecutions: 5, processedTerminalIds: ['terminal-1'] },
    terminal: { id: 'terminal-2', rootTurnId: 'turn-2', outcome: 'completed' },
    authorized: true, userStopped: false, waitingApproval: false, superseded: false,
    uncertainEffects: false, completionVerified: false };
}
describe('Tower goal manager', () => {
  it('produces one durable intent without changing persistent goal identity', () => {
    const s = snapshot(); const before = structuredClone(s);
    const result = decideGoalSettlement(s);
    expect(result.kind).toBe('settle');
    if (result.kind !== 'settle') throw new Error();
    expect(result.intent).toMatchObject({ goalId: 'persistent-goal', expectedGoalVersion: 4 });
    expect(result.goal.activeExecution).toBeNull();
    expect(result.goal.dispatched).toBe(2); // Admission, not planning, consumes next budget.
    expect(s).toEqual(before);
    expect(decideGoalSettlement({ ...s, goal: result.goal })).toEqual({ kind: 'ignore', reason: 'duplicate_terminal' });
  });
  it.each([
    ['userStopped', 'user_stopped'], ['waitingApproval', 'waiting_approval'],
    ['superseded', 'superseded'], ['uncertainEffects', 'uncertain_effects'],
  ] as const)('blocks %s even when completion is claimed', (key, reason) => {
    const s = snapshot(); s[key] = true; s.goal.state.status = 'completed'; s.completionVerified = true;
    expect(decideGoalSettlement(s)).toMatchObject({ kind: 'settle', reason });
    expect(decideGoalSettlement(s)).not.toHaveProperty('intent');
  });
  it.each(['failed', 'aborted', 'uncertain'] as const)('never schedules transport recovery for %s', outcome => {
    const s = snapshot(); s.terminal.outcome = outcome;
    expect(decideGoalSettlement(s)).not.toHaveProperty('intent');
  });
  it('requires verified completion', () => {
    const s = snapshot(); s.goal.state.status = 'completed';
    expect(decideGoalSettlement(s)).toMatchObject({ reason: 'completion_unverified' });
    s.completionVerified = true;
    expect(decideGoalSettlement(s)).toMatchObject({ reason: 'completed' });
  });
  it('rejects old turn terminals and unauthorized snapshots', () => {
    const s = snapshot(); s.terminal.rootTurnId = 'turn-1';
    expect(decideGoalSettlement(s)).toMatchObject({ kind: 'ignore', reason: 'stale_execution' });
    s.authorized = false;
    expect(decideGoalSettlement(s)).toMatchObject({ kind: 'ignore', reason: 'unauthorized' });
  });
  it('bounds iterations and requires actual progress', () => {
    const s = snapshot(); s.goal.progressVersion = 1;
    expect(decideGoalSettlement(s)).toMatchObject({ reason: 'no_state_progress' });
    s.goal.progressVersion = 2; s.goal.dispatched = 5;
    expect(decideGoalSettlement(s)).toMatchObject({ reason: 'execution_budget_exhausted' });
    s.goal.dispatched = 2; s.goal.state.cycles = 5;
    expect(decideGoalSettlement(s)).toMatchObject({ reason: 'cycle_budget_exhausted' });
  });
  it('rejects mismatched store events and propagates transaction errors', async () => {
    const manager = createGoalManager({ settleTerminal: async (_g, _t, decide) => decide(snapshot()) });
    await expect(manager.onTerminal('wrong', 'terminal-2')).rejects.toThrow('GOAL_EVENT_MISMATCH');
    const failed = createGoalManager({ settleTerminal: async () => { throw new Error('rollback'); } });
    await expect(failed.onTerminal('persistent-goal', 'terminal-2')).rejects.toThrow('rollback');
  });
});
