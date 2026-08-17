import { beforeEach, describe, expect, it, vi } from 'vitest';

const { withLocks, assertHeld } = vi.hoisted(() => ({
  withLocks: vi.fn(),
  assertHeld: vi.fn(),
}));

vi.mock('./runtime-advisory-lock.js', () => ({
  withRuntimeAdvisoryLocks: withLocks,
  tryWithRuntimeAdvisoryLocks: withLocks,
  assertRuntimeAdvisoryLockHeld: assertHeld,
}));

import {
  assertRuntimeBoxLifecycleLockHeld,
  runtimeBoxLifecycleLockKey,
  tryWithRuntimeBoxLifecycleLock,
  withRuntimeBoxLifecycleLock,
} from './runtime-box-lifecycle-lock.js';

describe('Runtime Box lifecycle lock facade', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses one stable Box-scoped key and passes only its held token', async () => {
    const token = { key: 'opaque' };
    withLocks.mockImplementation(async (keys: string[], fn: (tokens: unknown[]) => Promise<unknown>) => {
      expect(keys).toEqual(['runtime-box-lifecycle:42']);
      return fn([token]);
    });

    await expect(withRuntimeBoxLifecycleLock(42, async held => {
      expect(held).toBe(token);
      return 'ok';
    })).resolves.toBe('ok');
  });

  it('returns tagged contention through the Box facade', async () => {
    withLocks.mockResolvedValue({ acquired: false });
    await expect(tryWithRuntimeBoxLifecycleLock(42, async () => 'unreachable')).resolves.toEqual({ acquired: false });
  });

  it('delegates authenticity checks to the primitive with the exact Box key', () => {
    const token = { key: 'opaque' } as any;
    assertRuntimeBoxLifecycleLockHeld(token, 7);
    expect(assertHeld).toHaveBeenCalledWith(token, 'runtime-box-lifecycle:7');
  });

  it('normalizes PostgreSQL BIGINT strings and rejects ids outside the safe integer domain', () => {
    expect(runtimeBoxLifecycleLockKey('42' as unknown as number)).toBe('runtime-box-lifecycle:42');
    expect(() => runtimeBoxLifecycleLockKey(0)).toThrow(/Invalid Runtime Box id/);
    expect(() => runtimeBoxLifecycleLockKey(1.5)).toThrow(/Invalid Runtime Box id/);
    expect(() => runtimeBoxLifecycleLockKey(Number.MAX_SAFE_INTEGER + 1)).toThrow(/Invalid Runtime Box id/);
    expect(() => runtimeBoxLifecycleLockKey('42.5' as unknown as number)).toThrow(/Invalid Runtime Box id/);
    expect(withLocks).not.toHaveBeenCalled();
  });
});
