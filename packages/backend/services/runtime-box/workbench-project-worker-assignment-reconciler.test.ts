import { describe, expect, it, vi } from 'vitest';
import { reconcileClaimedProjectWorkerAssignment } from './workbench-project-worker-assignment-reconciler.js';

const assignment = {
  project_id: 'p1', deployment_id: 'production', desired_worker_id: 'tower-prod-local-01',
  status: 'preparing', attempt: 1, reason: null, last_error: null, requested_by_user_id: 7,
  lease_owner: 'r1', lease_expires_at: '2099-01-01', created_at: '2026', updated_at: '2026', completed_at: null,
} as const;

function dependencies(failAt?: 'prepare' | 'verify' | 'binding' | 'complete') {
  const order: string[] = [];
  const rollback = vi.fn(async () => { order.push('rollback'); });
  return {
    order, rollback,
    deps: {
      prepareWorker: vi.fn(async () => { order.push('prepare'); if (failAt === 'prepare') throw new Error('prepare failed'); return { rollback }; }),
      verifyWorker: vi.fn(async () => { order.push('verify'); if (failAt === 'verify') throw new Error('verify failed'); }),
      activateBinding: vi.fn(async () => { order.push('binding'); if (failAt === 'binding') throw new Error('binding failed'); }),
      complete: vi.fn(async () => { order.push('complete'); return failAt !== 'complete'; }),
      fail: vi.fn(async () => { order.push('fail'); return true; }),
      recoveryRequired: vi.fn(async () => { order.push('recovery-required'); return true; }),
    },
  };
}

describe('Project Worker assignment reconciler', () => {
  it('activates binding only after prepare and Worker verification', async () => {
    const { deps, order } = dependencies();
    await expect(reconcileClaimedProjectWorkerAssignment(assignment as any, deps)).resolves.toEqual({ ok: true });
    expect(order).toEqual(['prepare', 'verify', 'binding', 'complete']);
  });

  it.each(['prepare', 'verify', 'binding'] as const)('keeps binding incomplete and records failure when %s fails', async failAt => {
    const { deps, order, rollback } = dependencies(failAt);
    await expect(reconcileClaimedProjectWorkerAssignment(assignment as any, deps)).resolves.toMatchObject({ ok: false });
    if (failAt !== 'binding') expect(deps.activateBinding).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
    if (failAt === 'prepare') expect(deps.recoveryRequired).toHaveBeenCalledOnce();
    else expect(deps.fail).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledTimes(failAt === 'prepare' ? 0 : 1);
    expect(order.at(-1)).toBe(failAt === 'prepare' ? 'recovery-required' : 'fail');
  });

  it('does not roll back prepared Worker scope after binding activation', async () => {
    const { deps, rollback } = dependencies('complete');
    await expect(reconcileClaimedProjectWorkerAssignment(assignment as any, deps)).resolves.toMatchObject({ ok: false });
    expect(deps.activateBinding).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(deps.fail).not.toHaveBeenCalled();
    expect(deps.recoveryRequired).toHaveBeenCalledOnce();
  });
});

 describe('assignment recovery boundaries', () => {
  it('requires recovery review if rollback fails', async () => {
    const { deps, rollback } = dependencies('verify');
    rollback.mockRejectedValueOnce(new Error('rollback unavailable'));
    await expect(reconcileClaimedProjectWorkerAssignment(assignment as any, deps)).resolves.toMatchObject({ ok: false });
    expect(deps.recoveryRequired).toHaveBeenCalledOnce();
    expect(deps.fail).not.toHaveBeenCalled();
    expect(deps.activateBinding).not.toHaveBeenCalled();
  });
  it('rejects an unclaimed request without external effects', async () => {
    const { deps } = dependencies();
    await expect(reconcileClaimedProjectWorkerAssignment({ ...assignment, status: 'pending' } as any, deps)).rejects.toThrow('NOT_CLAIMED');
    expect(deps.prepareWorker).not.toHaveBeenCalled();
  });
});

 describe('partial preparation failure', () => {
  it('quarantines a failure after identity mutation instead of declaring safe retry', async () => {
    const { deps } = dependencies();
    const state = { identity: 'old', config: 'old', binding: 'old' };
    deps.prepareWorker.mockImplementationOnce(async () => {
      state.identity = 'new';
      throw new Error('config write failed after rotation');
    });
    await expect(reconcileClaimedProjectWorkerAssignment(assignment as any, deps)).resolves.toMatchObject({ ok: false });
    expect(state).toEqual({ identity: 'new', config: 'old', binding: 'old' });
    expect(deps.recoveryRequired).toHaveBeenCalledWith(expect.objectContaining({ error: 'config write failed after rotation' }));
    expect(deps.fail).not.toHaveBeenCalled();
    expect(deps.verifyWorker).not.toHaveBeenCalled();
    expect(deps.activateBinding).not.toHaveBeenCalled();
  });
});
