import { describe, it, expect, vi } from 'vitest';
import { admitGoal, goalRequestFromInvocation } from './goal-admission';
const context = { sessionId: 's', rootTurnId: 'r', projectId: 'p', userId: 1, ownerToken: 'fixture', ownerBootId: 'boot' };
const request = { goal: 'fix', origin: 'explicit-skill' as const };
describe('explicit goal admission', () => {
  it('ignores mentions, empty arguments and other skills', () => {
    expect(goalRequestFromInvocation({ skillName: 'goal', explicit: false, args: 'fix' })).toBeUndefined();
    expect(goalRequestFromInvocation({ skillName: 'goal', explicit: true, args: '' })).toBeUndefined();
    expect(goalRequestFromInvocation({ skillName: 'other', explicit: true, args: 'fix' })).toBeUndefined();
    expect(goalRequestFromInvocation({ skillName: 'goal', explicit: true, args: 'fix' })).toEqual(request);
  });
  it('leaves ordinary runs alone', async () => { expect(await admitGoal(undefined, context)).toEqual({ kind: 'ordinary' }); });
  it('reports missing runtime without silently downgrading', async () => { expect(await admitGoal(request, context)).toEqual({ kind: 'unavailable', reason: 'goal_runtime_not_installed' }); });
  it('does not create before readiness', async () => {
    const provider = { ready: vi.fn(async () => false), create: vi.fn() };
    expect((await admitGoal(request, context, provider)).kind).toBe('unavailable'); expect(provider.create).not.toHaveBeenCalled();
  });
  it('passes closure identity only after readiness and requires both tools', async () => {
    const provider = { ready: vi.fn(async () => true), create: vi.fn(async () => ({ tools: [], afterInvocation: async () => ({ invocations: 0, reason: 'none' }) })) };
    expect(await admitGoal(request, context, provider)).toEqual({ kind: 'unavailable', reason: 'goal_tools_missing' });
    expect(provider.create).toHaveBeenCalledWith(context, request);
  });
});
