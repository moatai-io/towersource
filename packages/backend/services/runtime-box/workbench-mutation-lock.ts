import {
  assertRuntimeAdvisoryLockHeld,
  withRuntimeAdvisoryLocks,
  type RuntimeAdvisoryLockHeld,
} from './runtime-advisory-lock.js';

const WORKBENCH_MUTATION_PREFIX = 'runtime-box-workbench-tool-mutation:';

export function workbenchMutationLockKey(projectId: string): string {
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new Error('Project id is required for Workbench mutation lock');
  }
  return `${WORKBENCH_MUTATION_PREFIX}${projectId}`;
}

/** Shared M lock for Workbench revision writers and exact Runtime replacement readers. */
export async function withWorkbenchMutationLock<T>(
  projectId: string,
  fn: (held: RuntimeAdvisoryLockHeld) => Promise<T>,
): Promise<T> {
  const key = workbenchMutationLockKey(projectId);
  return withRuntimeAdvisoryLocks([key], async ([held]) => fn(held));
}

export function assertWorkbenchMutationLockHeld(
  held: RuntimeAdvisoryLockHeld,
  projectId: string,
): void {
  assertRuntimeAdvisoryLockHeld(held, workbenchMutationLockKey(projectId));
}

export type WorkbenchMutationLockHeld = RuntimeAdvisoryLockHeld;
