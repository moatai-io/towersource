import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const recreate = fs.readFileSync(path.join(import.meta.dirname, 'workbench-runtime-recreate.ts'), 'utf8');
const manager = fs.readFileSync(path.join(import.meta.dirname, 'runtime-box-manager.ts'), 'utf8');
const migration = fs.readFileSync(path.join(import.meta.dirname, '../../db/migrations/153_runtime_box_workbench_runtime_recreate_intents.sql'), 'utf8');

describe('A4b-minimal rebuilt source contract', () => {
  it('uses the approved M → try A → L ordering and no ad-hoc destructive advisory SQL', () => {
    const m = recreate.indexOf('withWorkbenchMutationLock(input.projectId');
    const a = recreate.indexOf('tryWithRuntimeBoxActivityLock(Number(intent.box_id)');
    const l = recreate.indexOf('withRuntimeBoxLifecycleLock(Number(intent.box_id)');
    expect(m).toBeGreaterThan(0);
    expect(a).toBeGreaterThan(m);
    expect(l).toBeGreaterThan(a);
    expect(recreate).not.toContain('runtime-box-recreate-destructive');
    expect(recreate).not.toContain('pg_advisory_lock');
  });

  it('keeps confirmation and Service acknowledgement before intent consumption', () => {
    expect(recreate.indexOf('CONFIRMATION_REQUIRED')).toBeLessThan(recreate.indexOf('markIntentApplying(intent.id)'));
    expect(recreate.indexOf('SERVICE_IMPACT_ACK_REQUIRED')).toBeLessThan(recreate.indexOf('markIntentApplying(intent.id)'));
    expect(recreate).toContain("'ACTIVE_EXECUTION', 'Runtime Box has an active execution; intent remains unused'");
  });

  it('uses authentic A/L tokens and never calls public ensureRunning or reclaim from exact replacement', () => {
    const start = manager.indexOf('export async function recreateRuntimeBoxExactWithLocksHeld');
    const end = manager.indexOf('// ── Box 시작 / 종료', start);
    const exact = manager.slice(start, end);
    expect(exact).toContain('assertRuntimeBoxActivityLockHeld(input.activity, input.boxId)');
    expect(exact).toContain('assertRuntimeBoxLifecycleLockHeld(input.lifecycle, input.boxId)');
    expect(exact).toContain("startDockerContainer(starting, { cleanupContainerName: false })");
    expect(exact).not.toContain('ensureRunning(');
    expect(exact).not.toContain('reclaim');
    expect(exact).not.toContain('oldContainerRestored: true');
  });

  it('scopes Service impact to the exact Box and fails closed on project drift', () => {
    expect(recreate).toContain("WHERE box_id=$1 AND status IN ('running','pending') ORDER BY id");
    expect(recreate).toContain('service.project_id !== projectId');
    expect(recreate).toContain('SERVICE_IDENTITY_MISMATCH');
    expect(recreate).not.toContain("WHERE project_id=$1 AND status IN ('running','pending') ORDER BY id");
  });

  it('contains no Seam C journal, backup, or automatic adoption surface', () => {
    expect(recreate + manager + migration).not.toMatch(/filesystem journal|operation_journal|backup generation|restoreOldContainer|adoptStarting/i);
    expect(migration).toContain("status IN ('previewed','applying','succeeded','failed','recovery_required')");
  });
});
