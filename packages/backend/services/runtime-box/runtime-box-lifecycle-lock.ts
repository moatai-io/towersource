import {
  assertRuntimeAdvisoryLockHeld,
  tryWithRuntimeAdvisoryLocks,
  withRuntimeAdvisoryLocks,
  type RuntimeAdvisoryLockHeld,
  type RuntimeAdvisoryTryResult,
} from './runtime-advisory-lock.js';
import { normalizeRuntimeBoxId } from './runtime-box-row-normalization.js';

const SERVICE_LIFECYCLE_PREFIX = 'runtime-box-lifecycle:';

/** Stable Box-scoped key shared by Service writers and later Runtime lifecycle owners. */
export function runtimeBoxLifecycleLockKey(boxId: number): string {
  return `${SERVICE_LIFECYCLE_PREFIX}${normalizeRuntimeBoxId(boxId)}`;
}

/**
 * Narrow Service-facing facade over the generic advisory-lock primitive.
 * Callers provide only a Box id and business callback; PostgreSQL/session cleanup
 * remains encapsulated in runtime-advisory-lock.
 */
export async function withRuntimeBoxLifecycleLock<T>(
  boxId: number,
  fn: (held: RuntimeAdvisoryLockHeld) => Promise<T>,
): Promise<T> {
  const key = runtimeBoxLifecycleLockKey(boxId);
  return withRuntimeAdvisoryLocks([key], async ([held]) => fn(held));
}

export async function tryWithRuntimeBoxLifecycleLock<T>(
  boxId: number,
  fn: (held: RuntimeAdvisoryLockHeld) => Promise<T>,
): Promise<RuntimeAdvisoryTryResult<T>> {
  const key = runtimeBoxLifecycleLockKey(boxId);
  return tryWithRuntimeAdvisoryLocks([key], async ([held]) => fn(held));
}

export function assertRuntimeBoxLifecycleLockHeld(
  held: RuntimeAdvisoryLockHeld,
  boxId: number,
): void {
  assertRuntimeAdvisoryLockHeld(held, runtimeBoxLifecycleLockKey(boxId));
}

export type RuntimeBoxLifecycleLockHeld = RuntimeAdvisoryLockHeld;
