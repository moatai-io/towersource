import { beforeEach, describe, expect, it, vi } from 'vitest';

const { blocking, trying, assertHeld } = vi.hoisted(() => ({
  blocking: vi.fn(),
  trying: vi.fn(),
  assertHeld: vi.fn(),
}));

vi.mock('./runtime-advisory-lock.js', () => ({
  withRuntimeAdvisoryLocks: blocking,
  tryWithRuntimeAdvisoryLocks: trying,
  assertRuntimeAdvisoryLockHeld: assertHeld,
}));

import {
  assertRuntimeBoxActivityLockHeld,
  runtimeBoxActivityLockKey,
  tryWithRuntimeBoxActivityLock,
  withRuntimeBoxActivityLock,
} from './runtime-box-activity-lock.js';
import { assertExecBoxIdentityStable } from './runtime-box-manager.js';

const started = { id: 9, status: 'running', container_id: 'container-a' } as any;

describe('Runtime Box ordering primitives', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the stable Box activity key for blocking callbacks', async () => {
    const token = { key: 'opaque' };
    blocking.mockImplementation(async (keys: string[], fn: (tokens: unknown[]) => Promise<unknown>) => {
      expect(keys).toEqual(['runtime-box-activity:42']);
      return fn([token]);
    });
    await expect(withRuntimeBoxActivityLock(42, async held => held)).resolves.toBe(token);
  });

  it('preserves tagged contention for non-blocking lifecycle callers', async () => {
    trying.mockResolvedValue({ acquired: false });
    await expect(tryWithRuntimeBoxActivityLock(42, async () => 'unreachable')).resolves.toEqual({ acquired: false });
  });

  it('delegates token authenticity with the exact activity key', () => {
    const token = { key: 'opaque' } as any;
    assertRuntimeBoxActivityLockHeld(token, 7);
    expect(assertHeld).toHaveBeenCalledWith(token, 'runtime-box-activity:7');
  });

  it('normalizes PostgreSQL BIGINT strings and rejects ids outside the safe integer domain', () => {
    expect(runtimeBoxActivityLockKey('62' as unknown as number)).toBe('runtime-box-activity:62');
    expect(() => runtimeBoxActivityLockKey(0)).toThrow(/Invalid Runtime Box id/);
    expect(() => runtimeBoxActivityLockKey(Number.NaN)).toThrow(/Invalid Runtime Box id/);
    expect(() => runtimeBoxActivityLockKey(Number.MAX_SAFE_INTEGER + 1)).toThrow(/Invalid Runtime Box id/);
    expect(() => runtimeBoxActivityLockKey('-1' as unknown as number)).toThrow(/Invalid Runtime Box id/);
    expect(blocking).not.toHaveBeenCalled();
  });

  it('accepts the same running container identity and rejects stale replacements', () => {
    expect(assertExecBoxIdentityStable(started, { ...started }, 9).container_id).toBe('container-a');
    expect(() => assertExecBoxIdentityStable(started, { ...started, container_id: 'container-b' }, 9)).toThrow(/changed before exec/);
    expect(() => assertExecBoxIdentityStable(started, { ...started, status: 'stopped' }, 9)).toThrow(/changed before exec/);
    expect(() => assertExecBoxIdentityStable(started, undefined, 9)).toThrow(/not found/);
  });
});
