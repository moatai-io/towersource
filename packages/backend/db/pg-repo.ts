/**
 * pg-repo.ts — Async query helpers for PostgreSQL.
 *
 * Usage:
 *   import { query, queryOne, execute, transaction } from '../db/pg-repo.js';
 *
 *   const user = await queryOne<User>('SELECT * FROM users WHERE id = $1', [id]);
 *   const rows = await query<Session>('SELECT * FROM sessions WHERE user_id = $1', [userId]);
 *   await execute('UPDATE sessions SET name = $1 WHERE id = $2', [name, id]);
 */
import { getPgPool } from './pg.js';
import type { PoolClient } from 'pg';

/** SELECT multiple rows → T[] (replaces prepare().all()) */
export async function query<T = any>(sql: string, params?: any[]): Promise<T[]> {
  const { rows } = await getPgPool().query(sql, params);
  return rows as T[];
}

/** SELECT single row → T | undefined (replaces prepare().get()) */
export async function queryOne<T = any>(sql: string, params?: any[]): Promise<T | undefined> {
  const { rows } = await getPgPool().query(sql, params);
  return rows[0] as T | undefined;
}

/** INSERT/UPDATE/DELETE → { changes: number } (replaces prepare().run()) */
export async function execute(sql: string, params?: any[]): Promise<{ changes: number }> {
  const result = await getPgPool().query(sql, params);
  return { changes: result.rowCount ?? 0 };
}

/** Transaction wrapper (replaces db.transaction(() => { ... })) */
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Transaction-aware query helpers.
 * Use inside transaction() callback with the provided client.
 */
export function withClient(client: PoolClient) {
  return {
    async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
      const { rows } = await client.query(sql, params);
      return rows as T[];
    },
    async queryOne<T = any>(sql: string, params?: any[]): Promise<T | undefined> {
      const { rows } = await client.query(sql, params);
      return rows[0] as T | undefined;
    },
    async execute(sql: string, params?: any[]): Promise<{ changes: number }> {
      const result = await client.query(sql, params);
      return { changes: result.rowCount ?? 0 };
    },
  };
}
