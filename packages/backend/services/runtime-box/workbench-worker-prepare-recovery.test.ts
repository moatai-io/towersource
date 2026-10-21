import { describe, it, expect, vi } from 'vitest';
import { prepareWorkerWithRecovery } from './workbench-worker-prepare-recovery.js';

describe('Worker partial prepare recovery', () => {
  function callbacks() {
    return { prepare: vi.fn(async () => {}), restore: vi.fn(async () => {}), verifyRestored: vi.fn(async () => {}) };
  }
  it('returns rollback without restoring successful preparation', async () => {
    const c = callbacks(); const handle = await prepareWorkerWithRecovery(c);
    expect(c.restore).not.toHaveBeenCalled();
    await handle.rollback(); expect(c.verifyRestored).toHaveBeenCalledOnce();
  });
  it('compensates a partially failed preparation and still rejects activation', async () => {
    const c = callbacks(); c.prepare.mockRejectedValueOnce(new Error('sensitive detail'));
    await expect(prepareWorkerWithRecovery(c)).rejects.toThrow('WORKER_PREPARE_FAILED_RESTORED');
    expect(c.restore).toHaveBeenCalledOnce(); expect(c.verifyRestored).toHaveBeenCalledOnce();
  });
  it.each(['restore', 'verifyRestored'] as const)('requires recovery if %s fails', async stage => {
    const c = callbacks(); c.prepare.mockRejectedValueOnce(new Error('private detail'));
    c[stage].mockRejectedValueOnce(new Error('private detail'));
    await expect(prepareWorkerWithRecovery(c)).rejects.toThrow('WORKER_PREPARE_RECOVERY_REQUIRED');
    if (stage === 'restore') expect(c.verifyRestored).not.toHaveBeenCalled();
  });
  it('propagates later rollback failure to the reconciler', async () => {
    const c = callbacks(); const handle = await prepareWorkerWithRecovery(c);
    c.verifyRestored.mockRejectedValueOnce(new Error('verification failed'));
    await expect(handle.rollback()).rejects.toThrow('verification failed');
  });
});

import { reconcileClaimedProjectWorkerAssignment } from './workbench-project-worker-assignment-reconciler.js';
import type { ProjectWorkerAssignmentDesire } from './workbench-project-worker-assignment.js';

describe('partial recovery wired into binding-last reconciliation', () => {
  const assignment = { status: 'preparing', lease_owner: 'test-owner' } as ProjectWorkerAssignmentDesire;
  it.each([false, true])('never activates after failed prepare; restoreFails=%s', async restoreFails => {
    const order: string[] = [];
    const activateBinding = vi.fn(async () => {});
    const recoveryRequired = vi.fn(async () => true);
    const fail = vi.fn(async () => true);
    const complete = vi.fn(async () => true);
    const result = await reconcileClaimedProjectWorkerAssignment(assignment, {
      prepareWorker: () => prepareWorkerWithRecovery({
        prepare: async () => { order.push('partial-write'); throw new Error('private detail'); },
        restore: async () => { order.push('restore'); if (restoreFails) throw new Error('private detail'); },
        verifyRestored: async () => { order.push('verify-restored'); },
      }),
      verifyWorker: vi.fn(async () => {}), activateBinding, recoveryRequired, fail, complete,
    });
    expect(result.ok).toBe(false);
    expect(order).toEqual(restoreFails ? ['partial-write', 'restore'] : ['partial-write', 'restore', 'verify-restored']);
    expect(activateBinding).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(recoveryRequired).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('private detail');
  });
});
