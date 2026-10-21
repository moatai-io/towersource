import { planWorkerRelease, type WorkerReleaseSnapshot } from './workbench-worker-release-plan.js';

export type ReleasePhase = 'planned' | 'draining' | 'switching' | 'verifying' | 'restoring-drain' | 'verified' | 'rolling-back' | 'rolled-back' | 'recovery-required';
export interface ReleaseReceipt {
  runId: string;
  targetStore: string;
  before: WorkerReleaseSnapshot;
  phase: ReleasePhase;
}
/** Implementations must bind actions to the receipt's Worker, preserve config/identity,
 * and hold a cross-process Worker lock for the whole callback. No production adapter yet. */
export interface WorkerReleasePorts {
  exclusive<T>(workerId: string, body: () => Promise<T>): Promise<T>;
  load(runId: string): Promise<ReleaseReceipt | undefined>;
  save(receipt: ReleaseReceipt): Promise<void>; // atomic + durable before returning
  inspect(workerId: string): Promise<WorkerReleaseSnapshot>;
  setDrain(workerId: string, draining: boolean): Promise<void>;
  waitQuiescent(workerId: string, signal: AbortSignal): Promise<boolean>; // bounded, process + run checks
  switchArtifact(receipt: ReleaseReceipt, signal: AbortSignal): Promise<void>;
  verify(receipt: ReleaseReceipt, signal: AbortSignal): Promise<boolean>; // live + config + health + Project smoke
  restore(receipt: ReleaseReceipt): Promise<boolean>; // independently bounded; includes original drain state
}

/** An interrupted nonterminal run is NOT blindly replayed: it needs operator reconciliation.
 * This runner does not claim exactly-once service operations across a crash. */
export async function runWorkerRelease(input: {
  runId: string; workerId: string; targetStore: string; signal: AbortSignal;
}, ports: WorkerReleasePorts): Promise<ReleaseReceipt> {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(input.runId)) throw new Error('WORKER_RELEASE_INVALID_RUN_ID');
  return ports.exclusive(input.workerId, async () => {
    const existing = await ports.load(input.runId);
    if (existing) {
      if (existing.before.workerId !== input.workerId || existing.targetStore !== input.targetStore) throw new Error('WORKER_RELEASE_RECEIPT_CONFLICT');
      if (['verified', 'rolled-back', 'recovery-required'].includes(existing.phase)) return existing;
      const blocked: ReleaseReceipt = { ...existing, phase: 'recovery-required' };
      await ports.save(blocked);
      return blocked;
    }
    const before = await ports.inspect(input.workerId);
    planWorkerRelease(input.targetStore, [input.workerId], [before]);
    let receipt: ReleaseReceipt = { runId: input.runId, targetStore: input.targetStore, before: { ...before }, phase: 'planned' };
    const persist = async (phase: ReleasePhase) => {
      const next = { ...receipt, phase };
      await ports.save(next);
      receipt = next;
    };
    const checkAbort = () => { if (input.signal.aborted) throw new Error('WORKER_RELEASE_ABORTED'); };
    await ports.save(receipt);
    checkAbort();
    // Journal intent before the first mutation, including drain.
    await persist('draining');
    let switchAttempted = false;
    try {
      await ports.setDrain(input.workerId, true);
      checkAbort();
      if (!await ports.waitQuiescent(input.workerId, input.signal)) throw new Error('WORKER_RELEASE_BUSY');
      checkAbort();
      const fresh = await ports.inspect(input.workerId);
      if (fresh.workerId !== before.workerId || fresh.configuredStore !== before.configuredStore
        || fresh.liveStore !== before.liveStore || fresh.draining !== true || fresh.activeRuns !== 0) throw new Error('WORKER_RELEASE_STALE_PLAN');
      await persist('switching');
      switchAttempted = true;
      await ports.switchArtifact(receipt, input.signal);
      checkAbort();
      await persist('verifying');
      if (await ports.verify(receipt, input.signal) !== true) throw new Error('WORKER_RELEASE_VERIFY_FAILED');
      checkAbort();
      await persist('restoring-drain');
      await ports.setDrain(input.workerId, before.draining);
      await persist('verified');
    } catch {
      // If journal persistence fails, do not execute an unjournaled rollback.
      await persist('rolling-back');
      let restored = false;
      try {
        if (switchAttempted) {
          restored = await ports.restore(receipt) === true;
        } else {
          // No artifact was touched: never restart a busy Worker as a 'rollback'.
          await ports.setDrain(input.workerId, before.draining);
          const current = await ports.inspect(input.workerId);
          restored = current.workerId === before.workerId && current.draining === before.draining;
        }
      } catch { /* Explicit manual recovery below. */ }
      await persist(restored ? 'rolled-back' : 'recovery-required');
    }
    return receipt;
  });
}
