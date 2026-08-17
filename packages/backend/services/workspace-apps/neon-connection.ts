/**
 * Owns: one-shot read-only PostgreSQL/Neon query execution for Workspace Apps. Public API: runWorkspaceAppReadOnlyQuery().
 * See README.md.
 */

import { Pool } from 'pg';

export interface WorkspaceAppQueryResult {
  columns: string[];
  rows: Array<Record<string, string>>;
  rowCount: number;
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export async function runWorkspaceAppReadOnlyQuery(input: {
  connectionString: string;
  sql: string;
  rowLimit?: number;
  statementTimeoutMs?: number;
}): Promise<WorkspaceAppQueryResult> {
  const rowLimit = Math.max(1, Math.min(input.rowLimit ?? 200, 500));
  const statementTimeoutMs = Math.max(250, Math.min(input.statementTimeoutMs ?? 5_000, 15_000));
  const pool = new Pool({ connectionString: input.connectionString, max: 1, idleTimeoutMillis: 1_000, connectionTimeoutMillis: 3_000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
    await client.query('SET LOCAL default_transaction_read_only = on');
    const wrappedSql = `SELECT * FROM (${input.sql}) AS workspace_apps_query LIMIT ${rowLimit}`;
    const result = await client.query<Record<string, unknown>>(wrappedSql);
    await client.query('COMMIT');
    const columns = result.fields.map((field) => field.name);
    return {
      columns,
      rows: result.rows.map((row) => Object.fromEntries(columns.map((column) => [column, stringifyCell(row[column])]))),
      rowCount: result.rowCount ?? result.rows.length,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
  }
}
