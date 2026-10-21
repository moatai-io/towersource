import { describe, expect, it } from 'vitest';
import { advanceWorkerRelease as step, planWorkerRelease } from './workbench-worker-release-plan.js';
const old = '/nix/store/' + 'a'.repeat(32) + '-tower-old';
const target = '/nix/store/' + 'b'.repeat(32) + '-tower-new';
const snapshot = { workerId: 'primary', configuredStore: old, liveStore: old, activeRuns: 0, draining: true };
describe('explicit Worker release planning', () => {
  it('does not automatically enroll unassigned or other Workers', () => {
    const plan = planWorkerRelease(target, ['primary'], [snapshot, { ...snapshot, workerId: 'canary' }]);
    expect(plan.workers).toEqual([{ ...snapshot, action: 'upgrade' }]);
    expect(plan.workers[0].draining).toBe(true);
  });
  it('requires both live and configured artifact convergence', () => {
    expect(planWorkerRelease(target, ['primary'], [{ ...snapshot, configuredStore: target }]).workers[0].action).toBe('upgrade');
    expect(planWorkerRelease(target, ['primary'], [{ ...snapshot, configuredStore: target, liveStore: target }]).workers[0].action).toBe('keep');
  });
  it('rejects implicit or duplicate targets and ambiguous inventory', () => {
    expect(() => planWorkerRelease(target, [], [snapshot])).toThrow();
    expect(() => planWorkerRelease(target, ['primary', 'primary'], [snapshot])).toThrow();
    expect(() => planWorkerRelease(target, ['primary'], [snapshot, snapshot])).toThrow();
    expect(() => planWorkerRelease(target, ['missing'], [snapshot])).toThrow();
  });
});
describe('Worker release safety transitions', () => {
  it('cannot switch before drain and both activity checks pass', () => {
    expect(() => step('planned', { type: 'switch-started' })).toThrow();
    expect(step('planned', { type: 'drain-confirmed' })).toBe('draining');
    expect(step('draining', { type: 'quiescent', activeRuns: 1, activeProcesses: 0 })).toBe('draining');
    expect(step('draining', { type: 'quiescent', activeRuns: 0, activeProcesses: 1 })).toBe('draining');
    expect(step('draining', { type: 'quiescent', activeRuns: 0, activeProcesses: 0 })).toBe('ready');
    expect(() => step('draining', { type: 'quiescent', activeRuns: -1, activeProcesses: 0 })).toThrow();
  });
  it('does not accept heartbeat alone as release verification', () => {
    expect(step('verifying', { type: 'verified', configuredMatches: true, liveMatches: false, health: true, projectSmoke: true })).toBe('rollback-required');
    expect(step('verifying', { type: 'verified', configuredMatches: true, liveMatches: true, health: true, projectSmoke: false })).toBe('rollback-required');
    expect(step('verifying', { type: 'verified', configuredMatches: true, liveMatches: true, health: true, projectSmoke: true })).toBe('verified');
  });
  it('requires restoration of prior drain state as well as code and config', () => {
    expect(step('switching', { type: 'failed' })).toBe('rollback-required');
    expect(step('rollback-required', { type: 'rollback-started' })).toBe('rolling-back');
    expect(step('rolling-back', { type: 'rollback-completed', liveRestored: true, configRestored: true, drainRestored: false })).toBe('recovery-required');
    expect(step('rolling-back', { type: 'rollback-completed', liveRestored: true, configRestored: true, drainRestored: true })).toBe('rolled-back');
    expect(step('rolling-back', { type: 'failed' })).toBe('recovery-required');
  });
  it('rejects replaying destructive transitions after terminal completion', () => {
    expect(() => step('verified', { type: 'switch-started' })).toThrow();
    expect(() => step('rolled-back', { type: 'rollback-started' })).toThrow();
  });
});
