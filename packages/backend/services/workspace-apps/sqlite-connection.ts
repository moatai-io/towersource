/**
 * Owns: project-local SQLite read-only query execution for Workspace Apps. Public API: runWorkspaceAppSqliteReadOnlyQuery().
 * See README.md.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const MAX_SQLITE_DB_BYTES = 256 * 1024 * 1024;

export interface WorkspaceAppSqliteQueryResult {
  columns: string[];
  rows: Array<Record<string, string>>;
  rowCount: number;
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function resolveWorkspaceAppSqliteDatabasePath(input: {
  projectRoot: string;
  databasePath: string;
}): string {
  if (!input.databasePath || path.isAbsolute(input.databasePath)) {
    throw new Error('SQLite databasePath must be a project-relative path');
  }
  const normalized = path.normalize(input.databasePath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new Error('SQLite databasePath must stay inside the project root');
  }
  if (!/\.(db|sqlite|sqlite3)$/i.test(normalized)) {
    throw new Error('SQLite databasePath must end with .db, .sqlite, or .sqlite3');
  }

  const rootReal = fs.realpathSync(input.projectRoot);
  const resolved = path.resolve(rootReal, normalized);
  const dbReal = fs.realpathSync(resolved);
  if (!(dbReal === rootReal || dbReal.startsWith(rootReal + path.sep))) {
    throw new Error('SQLite databasePath escapes the project root');
  }
  const stat = fs.statSync(dbReal);
  if (!stat.isFile()) throw new Error('SQLite databasePath is not a file');
  if (stat.size > MAX_SQLITE_DB_BYTES) throw new Error('SQLite database is too large for Workspace Apps');
  return dbReal;
}

export async function runWorkspaceAppSqliteReadOnlyQuery(input: {
  projectRoot: string;
  databasePath: string;
  sql: string;
  rowLimit?: number;
  statementTimeoutMs?: number;
}): Promise<WorkspaceAppSqliteQueryResult> {
  const dbPath = resolveWorkspaceAppSqliteDatabasePath({ projectRoot: input.projectRoot, databasePath: input.databasePath });
  const rowLimit = Math.max(1, Math.min(input.rowLimit ?? 200, 500));
  const statementTimeoutMs = Math.max(250, Math.min(input.statementTimeoutMs ?? 5_000, 15_000));
  const wrappedSql = `SELECT * FROM (${input.sql}) AS workspace_apps_query LIMIT ${rowLimit};`;
  const { stdout } = await execFileAsync('sqlite3', ['-readonly', '-nofollow', '-json', dbPath, wrappedSql], {
    timeout: statementTimeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  });
  const parsed = stdout.trim() ? JSON.parse(stdout) : [];
  const sourceRows = Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
  const columns = Array.from(new Set(sourceRows.flatMap((row) => Object.keys(row))));
  return {
    columns,
    rows: sourceRows.map((row) => Object.fromEntries(columns.map((column) => [column, stringifyCell(row[column])]))),
    rowCount: sourceRows.length,
  };
}
