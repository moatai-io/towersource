import {
  assertRuntimeAdvisoryLockHeld,
  tryWithRuntimeAdvisoryLocks,
  withRuntimeAdvisoryLocks,
  type RuntimeAdvisoryLockHeld,
  type RuntimeAdvisoryTryResult,
} from './runtime-advisory-lock.js';
import { normalizeRuntimeBoxId } from './runtime-box-row-normalization.js';

const ACTIVITY_PREFIX = 'runtime-box-activity:';

export function runtimeBoxActivityLockKey(boxId: number): string {
  return `${ACTIVITY_PREFIX}${normalizeRuntimeBoxId(boxId)}`;
}

export async function withRuntimeBoxActivityLock<T>(
  boxId: number,
  fn: (held: RuntimeAdvisoryLockHeld) => Promise<T>,
): Promise<T> {
  const key = runtimeBoxActivityLockKey(boxId);
  return withRuntimeAdvisoryLocks([key], async ([held]) => fn(held));
}

export async function tryWithRuntimeBoxActivityLock<T>(
  boxId: number,
  fn: (held: RuntimeAdvisoryLockHeld) => Promise<T>,
): Promise<RuntimeAdvisoryTryResult<T>> {
  const key = runtimeBoxActivityLockKey(boxId);
  return tryWithRuntimeAdvisoryLocks([key], async ([held]) => fn(held));
}

export function assertRuntimeBoxActivityLockHeld(
  held: RuntimeAdvisoryLockHeld,
  boxId: number,
): void {
  assertRuntimeAdvisoryLockHeld(held, runtimeBoxActivityLockKey(boxId));
}

export type RuntimeBoxActivityEvidence =
  | { status: 'inactive'; activeExecutions: 0; evidence: 'activity-advisory-lock' }
  | { status: 'active'; activeExecutions: 1; evidence: 'activity-advisory-lock' }
  | { status: 'unknown'; activeExecutions: null; evidence: 'activity-advisory-lock'; reason: string };

/** Read-only preview evidence. Apply must still acquire A authoritatively. */
export async function probeRuntimeBoxActivity(boxId: number): Promise<RuntimeBoxActivityEvidence> {
  try {
    const result = await tryWithRuntimeBoxActivityLock(boxId, async () => undefined);
    return result.acquired
      ? { status: 'inactive', activeExecutions: 0, evidence: 'activity-advisory-lock' }
      : { status: 'active', activeExecutions: 1, evidence: 'activity-advisory-lock' };
  } catch (error) {
    return {
      status: 'unknown', activeExecutions: null, evidence: 'activity-advisory-lock',
      reason: String((error as Error)?.message ?? error).slice(0, 500),
    };
  }
}

export type RuntimeBoxActivityLockHeld = RuntimeAdvisoryLockHeld;
