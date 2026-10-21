/** Release planning only: never changes Project bindings, credentials or service state. */
export interface WorkerReleaseSnapshot {
  workerId: string;
  configuredStore: string;
  liveStore: string;
  activeRuns: number;
  draining: boolean;
}
export interface WorkerReleasePlan {
  targetStore: string;
  workers: Array<WorkerReleaseSnapshot & { action: 'keep' | 'upgrade' }>;
}
const storePattern = /^\/nix\/store\/[a-z0-9]{32}-[A-Za-z0-9+._-]+$/;
const idPattern = /^[A-Za-z0-9._-]{1,120}$/;
export function planWorkerRelease(targetStore: string, managedIds: string[], snapshots: WorkerReleaseSnapshot[]): WorkerReleasePlan {
  if (!storePattern.test(targetStore)) throw new Error('WORKER_RELEASE_INVALID_STORE');
  if (!managedIds.length || new Set(managedIds).size !== managedIds.length || managedIds.some(id => !idPattern.test(id))) {
    throw new Error('WORKER_RELEASE_EXPLICIT_TARGETS_REQUIRED');
  }
  return { targetStore, workers: managedIds.map(workerId => {
    const matches = snapshots.filter(item => item.workerId === workerId);
    if (matches.length !== 1) throw new Error('WORKER_RELEASE_INVENTORY_AMBIGUOUS');
    const item = matches[0];
    if (!storePattern.test(item.configuredStore) || !storePattern.test(item.liveStore)
      || !Number.isSafeInteger(item.activeRuns) || item.activeRuns < 0 || typeof item.draining !== 'boolean') {
      throw new Error('WORKER_RELEASE_INVALID_SNAPSHOT');
    }
    return { ...item, action: item.configuredStore === targetStore && item.liveStore === targetStore ? 'keep' as const : 'upgrade' as const };
  }) };
}

/** Caller must persist every transition before side effects. This reducer grants no execution authority. */
export type WorkerReleaseState = 'planned' | 'draining' | 'ready' | 'switching' | 'verifying' | 'verified' | 'rollback-required' | 'rolling-back' | 'rolled-back' | 'recovery-required';
export type WorkerReleaseEvent =
  | { type: 'drain-confirmed' }
  | { type: 'quiescent'; activeRuns: number; activeProcesses: number }
  | { type: 'switch-started' }
  | { type: 'switch-completed' }
  | { type: 'verified'; configuredMatches: boolean; liveMatches: boolean; health: boolean; projectSmoke: boolean }
  | { type: 'failed' }
  | { type: 'rollback-started' }
  | { type: 'rollback-completed'; liveRestored: boolean; configRestored: boolean; drainRestored: boolean };
export function advanceWorkerRelease(state: WorkerReleaseState, event: WorkerReleaseEvent): WorkerReleaseState {
  if (event.type === 'failed') {
    if (state === 'rolling-back') return 'recovery-required';
    if (['draining', 'ready', 'switching', 'verifying'].includes(state)) return 'rollback-required';
  }
  if (state === 'planned' && event.type === 'drain-confirmed') return 'draining';
  if (state === 'draining' && event.type === 'quiescent') {
    if (![event.activeRuns, event.activeProcesses].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('WORKER_RELEASE_INVALID_ACTIVITY');
    return event.activeRuns === 0 && event.activeProcesses === 0 ? 'ready' : 'draining';
  }
  if (state === 'ready' && event.type === 'switch-started') return 'switching';
  if (state === 'switching' && event.type === 'switch-completed') return 'verifying';
  if (state === 'verifying' && event.type === 'verified') {
    return [event.configuredMatches, event.liveMatches, event.health, event.projectSmoke].every(v => v === true) ? 'verified' : 'rollback-required';
  }
  if (state === 'rollback-required' && event.type === 'rollback-started') return 'rolling-back';
  if (state === 'rolling-back' && event.type === 'rollback-completed') {
    return [event.liveRestored, event.configRestored, event.drainRestored].every(v => v === true) ? 'rolled-back' : 'recovery-required';
  }
  throw new Error('WORKER_RELEASE_INVALID_TRANSITION');
}
