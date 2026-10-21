import { describe, it, expect, vi } from 'vitest';
import { startGoal } from './goal-loop';
import { continueGoal, decideGoalContinuation, type ContinuationContext } from './goal-continuation';
import type { GoalRecord } from './goal-session';
const context: ContinuationContext = { latestRootTurnId: 'r', ownerTokenValid: true, userStopped: false, waitingApproval: false, uncertainSideEffect: false, invocationOutcome: 'completed' };
function record(): GoalRecord { return { scope: { userId: 1, projectId: 'p', sessionId: 's', rootTurnId: 'r' }, version: 1, receipts: {}, state: startGoal('fix', [{ id: 'a', description: 'pass' }]) }; }
describe('goal model continuation control', () => {
  it.each([
    [{ userStopped: true }, 'user_stopped'],
    [{ waitingApproval: true }, 'waiting_approval'],
    [{ ownerTokenValid: false }, 'ownership_lost'],
    [{ latestRootTurnId: 'new' }, 'superseded'],
    [{ uncertainSideEffect: true }, 'uncertain_side_effect'],
    [{ invocationOutcome: 'failed' }, 'invocation_not_completed'],
  ] as const)('blocks unsafe continuation %j', (override, reason) => {
    expect(decideGoalContinuation(record(), { ...context, ...override })).toEqual({ continue: false, reason });
  });
  it('actually dispatches again until terminal goal state', async () => {
    const r = record();
    const dispatch = vi.fn(async () => { r.version++; if (r.version === 3) r.state.status = 'completed'; return true; });
    expect(await continueGoal({ read: async () => structuredClone(r), context: async () => context, dispatch }, new AbortController().signal)).toEqual({ invocations: 2, reason: 'completed' });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
  it('stops an agent that responds without updating goal state', async () => {
    const r = record(); const dispatch = vi.fn(async () => true);
    expect(await continueGoal({ read: async () => r, context: async () => context, dispatch }, new AbortController().signal)).toEqual({ invocations: 1, reason: 'no_state_progress' });
  });
  it('does not execute when stopped before dispatch', async () => {
    const dispatch = vi.fn();
    const result = await continueGoal({ read: async () => record(), context: async () => ({ ...context, userStopped: true }), dispatch }, new AbortController().signal);
    expect(result.reason).toBe('user_stopped'); expect(dispatch).not.toHaveBeenCalled();
  });
  it('honors atomic dispatch denial', async () => {
    expect(await continueGoal({ read: async () => record(), context: async () => context, dispatch: async () => false }, new AbortController().signal)).toEqual({ invocations: 0, reason: 'claim_denied' });
  });
});
