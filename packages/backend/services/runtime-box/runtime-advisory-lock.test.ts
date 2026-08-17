import { beforeEach, describe, expect, it, vi } from 'vitest';

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('../../db/pg.js', () => ({ getPgPool: () => ({ connect }) }));

import {
  assertRuntimeAdvisoryLockHeld,
  tryWithRuntimeAdvisoryLocks,
  withRuntimeAdvisoryLocks,
} from './runtime-advisory-lock.js';

function fakeClient(query: ReturnType<typeof vi.fn>) {
  return { query, release: vi.fn() };
}

describe('runtime advisory lock primitive', () => {
  beforeEach(() => vi.clearAllMocks());

  it('acquires in input order and releases every key in reverse order', async () => {
    const calls: string[] = [];
    const client = fakeClient(vi.fn(async (sql: string, values: unknown[]) => {
      const key = String(values[0]);
      if (sql.includes('pg_advisory_lock(')) calls.push(`lock:${key}`);
      if (sql.includes('pg_advisory_unlock(')) calls.push(`unlock:${key}`);
      return { rows: sql.includes('unlock') ? [{ released: true }] : [{}] };
    }));
    connect.mockResolvedValue(client);

    await expect(withRuntimeAdvisoryLocks(['M', 'A', 'L'], async tokens => {
      calls.push('callback');
      tokens.forEach((token, index) => assertRuntimeAdvisoryLockHeld(token, ['M', 'A', 'L'][index]));
      return 7;
    })).resolves.toBe(7);

    expect(calls).toEqual(['lock:M', 'lock:A', 'lock:L', 'callback', 'unlock:L', 'unlock:A', 'unlock:M']);
    expect(client.release).toHaveBeenCalledWith();
  });

  it('rejects forged, cross-key, and revoked tokens', async () => {
    const client = fakeClient(vi.fn(async (sql: string) => ({ rows: sql.includes('unlock') ? [{ released: true }] : [{}] })));
    connect.mockResolvedValue(client);
    let captured: unknown;

    await withRuntimeAdvisoryLocks(['L:1'], async tokens => {
      captured = tokens[0];
      expect(() => assertRuntimeAdvisoryLockHeld(tokens[0], 'L:2')).toThrow(/not authentic/);
      expect(() => assertRuntimeAdvisoryLockHeld({ key: 'L:1' } as any, 'L:1')).toThrow(/not authentic/);
    });

    expect(() => assertRuntimeAdvisoryLockHeld(captured as any, 'L:1')).toThrow(/not authentic/);
  });

  it('attempts every unlock and destroys the connection when cleanup is uncertain', async () => {
    const unlocks: string[] = [];
    const client = fakeClient(vi.fn(async (sql: string, values: unknown[]) => {
      if (!sql.includes('unlock')) return { rows: [{}] };
      const key = String(values[0]);
      unlocks.push(key);
      if (key === 'L') throw new Error('lost connection');
      return { rows: [{ released: true }] };
    }));
    connect.mockResolvedValue(client);

    await expect(withRuntimeAdvisoryLocks(['A', 'L'], async () => undefined)).rejects.toThrow('lost connection');
    expect(unlocks).toEqual(['L', 'A']);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('preserves both operation and cleanup errors', async () => {
    const operationError = new Error('operation failed');
    const cleanupError = new Error('cleanup failed');
    const client = fakeClient(vi.fn(async (sql: string) => {
      if (sql.includes('unlock')) throw cleanupError;
      return { rows: [{}] };
    }));
    connect.mockResolvedValue(client);

    const error = await withRuntimeAdvisoryLocks(['L'], async () => { throw operationError; }).catch(value => value);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.cause).toBe(operationError);
    expect(error.errors).toEqual([operationError, cleanupError]);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('returns a tagged non-acquired result and releases partial try-lock acquisition', async () => {
    const unlocks: string[] = [];
    const client = fakeClient(vi.fn(async (sql: string, values: unknown[]) => {
      const key = String(values[0]);
      if (sql.includes('try_advisory')) return { rows: [{ acquired: key === 'A' }] };
      if (sql.includes('unlock')) { unlocks.push(key); return { rows: [{ released: true }] }; }
      throw new Error(`unexpected query: ${sql}`);
    }));
    connect.mockResolvedValue(client);
    const callback = vi.fn();

    await expect(tryWithRuntimeAdvisoryLocks(['A', 'L'], callback)).resolves.toEqual({ acquired: false });
    expect(callback).not.toHaveBeenCalled();
    expect(unlocks).toEqual(['A']);
    expect(client.release).toHaveBeenCalledWith();
  });

  it('destroys the connection when blocking acquisition outcome is uncertain', async () => {
    const acquisitionError = new Error('lock response lost');
    const client = fakeClient(vi.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_lock(')) throw acquisitionError;
      throw new Error(`unexpected query: ${sql}`);
    }));
    connect.mockResolvedValue(client);

    await expect(withRuntimeAdvisoryLocks(['L'], async () => 'unreachable')).rejects.toBe(acquisitionError);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('destroys the connection when try-lock acquisition outcome is uncertain after cleaning known locks', async () => {
    const acquisitionError = new Error('try-lock response lost');
    const unlocks: string[] = [];
    const client = fakeClient(vi.fn(async (sql: string, values: unknown[]) => {
      const key = String(values[0]);
      if (sql.includes('try_advisory')) {
        if (key === 'A') return { rows: [{ acquired: true }] };
        throw acquisitionError;
      }
      if (sql.includes('unlock')) {
        unlocks.push(key);
        return { rows: [{ released: true }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }));
    connect.mockResolvedValue(client);

    await expect(tryWithRuntimeAdvisoryLocks(['A', 'L'], async () => 'unreachable')).rejects.toBe(acquisitionError);
    expect(unlocks).toEqual(['A']);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('uses the same destructive cleanup policy for try-lock callbacks', async () => {
    const client = fakeClient(vi.fn(async (sql: string) => {
      if (sql.includes('try_advisory')) return { rows: [{ acquired: true }] };
      if (sql.includes('unlock')) return { rows: [{ released: false }] };
      return { rows: [{}] };
    }));
    connect.mockResolvedValue(client);

    await expect(tryWithRuntimeAdvisoryLocks(['L'], async () => 'ok')).rejects.toThrow(/not held/);
    expect(client.release).toHaveBeenCalledWith(true);
  });
});
