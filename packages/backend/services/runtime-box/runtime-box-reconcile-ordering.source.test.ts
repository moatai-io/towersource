import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const manager = fs.readFileSync(path.resolve(import.meta.dirname, 'runtime-box-manager.ts'), 'utf8');

describe('Runtime Box reconcile lifecycle ordering regression', () => {
  it('treats confirmed-stale reconcile as a try A → L writer and re-observes under both locks', () => {
    const helper = manager.slice(
      manager.indexOf('async function reconcileConfirmedStaleRunningBox'),
      manager.indexOf('/**\n * DB 상태와 Docker 컨테이너 상태를 맞춘다.'),
    );
    const entry = manager.slice(
      manager.indexOf('export async function reconcileRuntimeBoxes'),
      manager.indexOf('// ── 유틸'),
    );

    const activity = helper.indexOf('tryWithRuntimeBoxActivityLock(boxId');
    const lifecycle = helper.indexOf('withRuntimeBoxLifecycleLock(boxId');
    const reload = helper.indexOf("WHERE id=$1 AND status='running'");
    const observe = helper.indexOf('observeRuntimeBoxContainer({');
    const transition = helper.indexOf('transitionConfirmedStaleRuntime({');

    expect(activity).toBeGreaterThanOrEqual(0);
    expect(lifecycle).toBeGreaterThan(activity);
    expect(reload).toBeGreaterThan(lifecycle);
    expect(observe).toBeGreaterThan(reload);
    expect(transition).toBeGreaterThan(observe);
    expect(helper).toContain('assertRuntimeBoxActivityLockHeld(activityHeld, boxId)');
    expect(helper).toContain('assertRuntimeBoxLifecycleLockHeld(lifecycleHeld, boxId)');
    expect(helper).toContain('if (!activity.acquired)');
    expect(entry).toContain('await reconcileConfirmedStaleRunningBox(box.id)');
  });
});
