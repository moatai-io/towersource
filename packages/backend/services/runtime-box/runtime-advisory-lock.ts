import type { PoolClient } from 'pg';
import { getPgPool } from '../../db/pg.js';

const heldBrand: unique symbol = Symbol('runtime-advisory-lock-held');
const liveTokens = new WeakSet<object>();

export interface RuntimeAdvisoryLockHeld {
  readonly key: string;
  readonly [heldBrand]: true;
}

export type RuntimeAdvisoryTryResult<T> =
  | { acquired: false }
  | { acquired: true; value: T };

async function acquire(client: PoolClient, key: string): Promise<void> {
  await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
}

async function tryAcquire(client: PoolClient, key: string): Promise<boolean> {
  const result = await client.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
    [key],
  );
  return result.rows[0]?.acquired === true;
}

async function unlock(client: PoolClient, key: string): Promise<void> {
  const result = await client.query<{ released: boolean }>(
    'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released',
    [key],
  );
  if (result.rows[0]?.released !== true) {
    throw new Error(`Runtime advisory lock was not held: ${key}`);
  }
}

async function unlockAll(client: PoolClient, keys: readonly string[]): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const key of [...keys].reverse()) {
    try {
      await unlock(client, key);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function combineErrors(operationError: unknown, cleanupErrors: unknown[]): unknown {
  if (cleanupErrors.length === 0) return operationError;
  if (operationError === undefined) {
    return cleanupErrors.length === 1
      ? cleanupErrors[0]
      : new AggregateError(cleanupErrors, 'Runtime advisory lock cleanup failed');
  }
  return new AggregateError(
    [operationError, ...cleanupErrors],
    'Runtime operation and advisory lock cleanup both failed',
    { cause: operationError },
  );
}

function issueToken(key: string): RuntimeAdvisoryLockHeld {
  const token = Object.freeze({ key, [heldBrand]: true as const });
  liveTokens.add(token);
  return token;
}

function revokeToken(token: RuntimeAdvisoryLockHeld): void {
  liveTokens.delete(token);
}

export function assertRuntimeAdvisoryLockHeld(token: RuntimeAdvisoryLockHeld, key: string): void {
  if (typeof token !== 'object' || token === null || !liveTokens.has(token) || token.key !== key) {
    throw new Error(`Runtime advisory lock token is not authentic for key: ${key}`);
  }
}

async function finishClient(
  client: PoolClient,
  acquiredKeys: readonly string[],
  operationError: unknown,
  connectionUncertain = false,
): Promise<void> {
  const cleanupErrors = await unlockAll(client, acquiredKeys);
  if (connectionUncertain || cleanupErrors.length > 0) client.release(true);
  else client.release();
  const combined = combineErrors(operationError, cleanupErrors);
  if (combined !== undefined) throw combined;
}

export async function withRuntimeAdvisoryLocks<T>(
  keys: readonly string[],
  fn: (held: readonly RuntimeAdvisoryLockHeld[]) => Promise<T>,
): Promise<T> {
  const client = await getPgPool().connect();
  const acquired: string[] = [];
  const tokens: RuntimeAdvisoryLockHeld[] = [];
  let operationError: unknown;
  let connectionUncertain = false;
  let value: T | undefined;
  try {
    for (const key of keys) {
      try {
        await acquire(client, key);
      } catch (error) {
        // The server may have acquired the session lock before the response was
        // lost. The pool connection must not be reused in that uncertainty.
        connectionUncertain = true;
        throw error;
      }
      acquired.push(key);
      tokens.push(issueToken(key));
    }
    value = await fn(tokens);
  } catch (error) {
    operationError = error;
  } finally {
    for (const token of tokens) revokeToken(token);
  }
  await finishClient(client, acquired, operationError, connectionUncertain);
  return value as T;
}

export async function tryWithRuntimeAdvisoryLocks<T>(
  keys: readonly string[],
  fn: (held: readonly RuntimeAdvisoryLockHeld[]) => Promise<T>,
): Promise<RuntimeAdvisoryTryResult<T>> {
  const client = await getPgPool().connect();
  const acquired: string[] = [];
  const tokens: RuntimeAdvisoryLockHeld[] = [];
  let operationError: unknown;
  let connectionUncertain = false;
  let result: RuntimeAdvisoryTryResult<T> | undefined;
  try {
    for (const key of keys) {
      let acquiredKey: boolean;
      try {
        acquiredKey = await tryAcquire(client, key);
      } catch (error) {
        // As with blocking acquisition, a lost response makes session lock
        // ownership unknowable. Discard the connection after known cleanup.
        connectionUncertain = true;
        throw error;
      }
      if (!acquiredKey) {
        result = { acquired: false };
        break;
      }
      acquired.push(key);
      tokens.push(issueToken(key));
    }
    if (result === undefined) {
      result = { acquired: true, value: await fn(tokens) };
    }
  } catch (error) {
    operationError = error;
  } finally {
    for (const token of tokens) revokeToken(token);
  }
  await finishClient(client, acquired, operationError, connectionUncertain);
  return result!;
}
