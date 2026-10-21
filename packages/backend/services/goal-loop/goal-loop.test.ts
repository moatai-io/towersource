import { describe, expect, it } from 'vitest';
import { runGoal, startGoal, type GoalPorts, type GoalState } from './goal-loop';

function fixture() {
  const calls: string[] = [];
  const saved: GoalState[] = [];
  const controller = new AbortController();
  const ports: GoalPorts = {
    inspect: async () => { calls.push('inspect'); return { decision: 'change', reason: 'fix' }; },
    change: async s => { calls.push('change'); return { revision: `r${s.cycles}` }; },
    check: async s => { calls.push('check'); return { outcome: 'improved', evidence: [
      { criterionId: 'a', revision: s.revision, reference: 'test receipt', passed: s.cycles >= 2 },
    ] }; },
    save: async s => { saved.push(structuredClone(s)); },
  };
  return { calls, saved, controller, ports, initial: startGoal('fix', [{ id: 'a', description: 'passes' }]) };
}

describe('bounded Inspect Change Check runner', () => {
  it('actually loops in order until evidence passes', async () => {
    const f = fixture();
    const result = await runGoal(f.initial, f.ports, f.controller.signal);
    expect(f.calls).toEqual(['inspect', 'change', 'check', 'inspect', 'change', 'check']);
    expect(result).toMatchObject({ status: 'completed', cycles: 2, revision: 'r2' });
    expect(f.saved.at(-1)).toEqual(result);
  });
  it('stops for approval without change', async () => {
    const f = fixture();
    f.ports.inspect = async () => ({ decision: 'needs_input', reason: 'deploy approval' });
    expect(await runGoal(f.initial, f.ports, f.controller.signal)).toMatchObject({ status: 'needs_input' });
    expect(f.calls).toEqual([]);
  });
  it('requires strategy change after two unchanged checks', async () => {
    const f = fixture();
    f.ports.check = async () => ({ outcome: 'unchanged', evidence: [] });
    expect(await runGoal(f.initial, f.ports, f.controller.signal)).toMatchObject({ reason: 'strategy_change_required', cycles: 3 });
    expect(f.calls.filter(c => c === 'change')).toHaveLength(2);
  });
  it('stops when a changed strategy also makes no progress', async () => {
    const f = fixture();
    f.ports.inspect = async () => ({ decision: 'change', reason: 'alternate', strategyChanged: true });
    f.ports.check = async () => ({ outcome: 'unchanged', evidence: [] });
    expect(await runGoal(f.initial, f.ports, f.controller.signal)).toMatchObject({ reason: 'no_progress_after_strategy_change' });
  });
  it('rejects stale evidence and obeys budget', async () => {
    const f = fixture(); f.initial.maxCycles = 1;
    f.ports.check = async () => ({ outcome: 'improved', evidence: [{ criterionId: 'a', revision: 'old', reference: 'test', passed: true }] });
    expect(await runGoal(f.initial, f.ports, f.controller.signal)).toMatchObject({ reason: 'cycle_budget_exhausted' });
  });
  it('does not retry uncertain changes', async () => {
    const f = fixture(); f.ports.change = async () => { throw new Error('transport'); };
    expect(await runGoal(f.initial, f.ports, f.controller.signal)).toMatchObject({ reason: 'change_result_uncertain', cycles: 1 });
  });
  it('does no work after cancellation', async () => {
    const f = fixture(); f.controller.abort();
    expect(await runGoal(f.initial, f.ports, f.controller.signal)).toMatchObject({ reason: 'cancelled' });
    expect(f.calls).toEqual([]);
  });
  it('cannot continue if persistence fails', async () => {
    const f = fixture(); f.ports.save = async () => { throw new Error('store offline'); };
    await expect(runGoal(f.initial, f.ports, f.controller.signal)).rejects.toThrow('store offline');
    expect(f.calls).toEqual([]);
  });
  it('allows verify-only without manufacturing a change', async () => {
    const f = fixture();
    f.ports.inspect = async () => ({ decision: 'verify', reason: 'already fixed' });
    f.ports.check = async s => ({ outcome: 'unchanged', evidence: [{ criterionId: 'a', revision: s.revision, reference: 'test', passed: true }] });
    expect(await runGoal(f.initial, f.ports, f.controller.signal)).toMatchObject({ status: 'completed' });
    expect(f.calls).toEqual([]);
  });
  it('does not replay interrupted running states', async () => {
    const f = fixture(); f.initial.cycles = 1;
    await expect(runGoal(f.initial, f.ports, f.controller.signal)).rejects.toThrow('RECONCILIATION_REQUIRED');
  });
  it.each([0, -1, 16, 1.5, NaN])('rejects invalid budget %s', budget => {
    expect(() => startGoal('fix', [{ id: 'a', description: 'pass' }], budget)).toThrow('INVALID_BUDGET');
  });
});
