import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const manager = fs.readFileSync(path.resolve(import.meta.dirname, 'runtime-box-manager.ts'), 'utf8');
const activity = fs.readFileSync(path.resolve(import.meta.dirname, 'runtime-box-activity-lock.ts'), 'utf8');
const mutation = fs.readFileSync(path.resolve(import.meta.dirname, 'workbench-tools.ts'), 'utf8');
const mutationLock = fs.readFileSync(path.resolve(import.meta.dirname, 'workbench-mutation-lock.ts'), 'utf8');

describe('L3a exec/destructive ordering contract', () => {
  it('starts before A, then uses a short L identity check while A remains around exec', () => {
    const entry = manager.slice(manager.indexOf('export async function execInBox'), manager.indexOf('export function assertExecBoxIdentityStable'));
    const held = manager.slice(manager.indexOf('async function execInBoxWithActivityLock'), manager.indexOf('// ── Reconcile'));

    expect(entry.indexOf('await ensureRunning(req.boxId, req.userId)')).toBeLessThan(entry.indexOf('withRuntimeBoxActivityLock(req.boxId'));
    expect(held).toContain('assertRuntimeBoxActivityLockHeld(activity, req.boxId)');
    expect(held).toContain('withRuntimeBoxLifecycleLock(req.boxId');
    expect(held.indexOf('withRuntimeBoxLifecycleLock(req.boxId')).toBeLessThan(held.indexOf('await execDockerCommand(runningBox'));
    expect(held).not.toContain('await ensureRunning(');
  });

  it('orders stop, destroy, and reclaim as A → L without recursive public stop calls', () => {
    const stop = manager.slice(manager.indexOf('export async function stopBox'), manager.indexOf('// ── Exec'));
    const reclaim = manager.slice(manager.indexOf('async function reclaimUserRuntimeBoxSlotOrThrow'), manager.indexOf('/**\n * Box 를 stop'));

    for (const source of [stop, reclaim]) {
      expect(source.indexOf('tryWithRuntimeBoxActivityLock')).toBeLessThan(source.indexOf('withRuntimeBoxLifecycleLock'));
      expect(source).toContain('stopBoxWithLocksHeld');
    }
    expect(reclaim).not.toContain('await stopBox(');
    expect(stop).not.toContain("await stopBox(boxId, 'stopped')");
  });

  it('keeps Workbench mutation on project M only, independent from Box A/L and Runtime row existence', () => {
    expect(mutation).toContain('withWorkbenchMutationLock(input.projectId');
    expect(mutationLock).toContain("const WORKBENCH_MUTATION_PREFIX = 'runtime-box-workbench-tool-mutation:'");
    expect(mutation).not.toContain('runtime-box-activity:');
    expect(mutation).not.toContain('runtime-box-lifecycle:');
    expect(activity).toContain("const ACTIVITY_PREFIX = 'runtime-box-activity:'");
  });
});
