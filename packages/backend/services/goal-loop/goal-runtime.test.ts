import { describe, it, expect, vi } from 'vitest';
import { createGoalRuntime } from './goal-runtime';
import type { GoalRecord, GoalStore } from './goal-session';
const scope = { userId: 1, projectId: 'p', sessionId: 's', rootTurnId: 'r' };
function fixture(enabled = true) {
  let stored: GoalRecord | null = null;
  const transact = vi.fn<GoalStore['transact']>(async (_scope, fn) => { const next = fn(stored); stored = next.record; return next.result; });
  const authority = { authorize: async () => true, verifyCheck: async () => true }; // fixture only
  const context = vi.fn(async () => ({ latestRootTurnId: 'r', ownerTokenValid: true, userStopped: false, waitingApproval: false, uncertainSideEffect: false, invocationOutcome: 'completed' as const }));
  const invoke = vi.fn(async (_v: number, _p: string, _s: AbortSignal) => false);
  const runtime = createGoalRuntime({ enabled, scope, store: { transact }, authority, host: { context, invoke } });
  const step = async (version: number, command: unknown) => runtime.tools[0].execute(`t${version}`, { requestId: `r${version}`, expectedVersion: version, command } as never);
  return { runtime, step, transact, context, invoke };
}
describe('goal tool and continuation composition', () => {
  it('does not expose tools or access storage when disabled', async () => {
    const f = fixture(false); expect(f.runtime.tools).toEqual([]);
    expect((await f.runtime.afterInvocation(new AbortController().signal)).reason).toBe('disabled'); expect(f.transact).not.toHaveBeenCalled();
  });
  it('does not continue ordinary chats without a goal', async () => {
    const f = fixture(); expect((await f.runtime.afterInvocation(new AbortController().signal)).reason).toBe('no_goal'); expect(f.invoke).not.toHaveBeenCalled();
  });
  it('connects actual tool steps to repeated fixture model invocations', async () => {
    const f = fixture();
    await f.step(0, { action: 'start', goal: 'fix', criteria: [{ id: 'a', description: 'passes' }] });
    f.invoke.mockImplementation(async (v, phase) => {
      const command = phase === 'inspect' ? { action: 'inspect', decision: 'change', reason: 'fix' }
        : phase === 'change' ? { action: 'change', revision: 'v2' }
        : { action: 'check', outcome: 'improved', evidence: [{ criterionId: 'a', revision: 'v2', reference: 'fixture-receipt', passed: true }] };
      const result = await f.step(v, command);
      expect((result as any).isError).toBe(false);
      return true;
    });
    expect(await f.runtime.afterInvocation(new AbortController().signal)).toEqual({ invocations: 3, reason: 'completed' });
    expect(f.invoke.mock.calls.map(c => c[1])).toEqual(['inspect', 'change', 'check']);
  });
  it('does not invoke after user stop', async () => {
    const f = fixture(); await f.step(0, { action: 'start', goal: 'fix', criteria: [{ id: 'a', description: 'passes' }] });
    f.context.mockResolvedValue({ latestRootTurnId: 'r', ownerTokenValid: true, userStopped: true, waitingApproval: false, uncertainSideEffect: false, invocationOutcome: 'completed' });
    expect((await f.runtime.afterInvocation(new AbortController().signal)).reason).toBe('user_stopped'); expect(f.invoke).not.toHaveBeenCalled();
  });
});
