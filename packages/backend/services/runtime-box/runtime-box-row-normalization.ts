import type { BoxRow, ServiceRow } from './types.js';

export type RawBoxRow = Omit<BoxRow, 'id' | 'created_by'> & {
  id: unknown;
  created_by: unknown;
};

export type RawServiceRow = Omit<ServiceRow, 'id' | 'box_id' | 'runner_kind' | 'worker_id'> & {
  id: unknown;
  box_id: unknown;
  runner_kind?: unknown;
  worker_id?: unknown;
};

function normalizePersistedPositiveSafeInteger(value: unknown, label: string): number {
  const normalized = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    const prefix = label === 'Runtime Box id' ? 'Invalid Runtime Box id' : `Invalid persisted ${label}`;
    throw new Error(`${prefix}: ${String(value)}`);
  }
  return normalized;
}

/** Normalize a PostgreSQL BIGINT Runtime Box identifier into the JS safe-integer domain. */
export function normalizeRuntimeBoxId(value: unknown): number {
  return normalizePersistedPositiveSafeInteger(value, 'Runtime Box id');
}

/** Normalize nullable persisted user identity fields on Runtime Box rows. */
export function normalizeNullableRuntimeBoxUserId(value: unknown): number | null {
  return value == null ? null : normalizePersistedPositiveSafeInteger(value, 'Runtime Box user id');
}

/** Convert one raw PostgreSQL Runtime Box row into the domain row contract. */
export function normalizeBoxRow(row: RawBoxRow): BoxRow {
  return {
    ...row,
    id: normalizeRuntimeBoxId(row.id),
    created_by: normalizeNullableRuntimeBoxUserId(row.created_by),
  };
}

/** Convert raw PostgreSQL Runtime Box rows without mutating the query results. */
export function normalizeBoxRows(rows: RawBoxRow[]): BoxRow[] {
  return rows.map(normalizeBoxRow);
}

/** Normalize a PostgreSQL BIGINT Runtime Box Service identifier into the JS safe-integer domain. */
export function normalizeRuntimeBoxServiceId(value: unknown): number {
  return normalizePersistedPositiveSafeInteger(value, 'Runtime Box Service id');
}

/** Convert one raw PostgreSQL Runtime Box Service row into the domain row contract. */
export function normalizeServiceRow(row: RawServiceRow): ServiceRow {
  const runnerKind = row.runner_kind === 'remote-worker' ? 'remote-worker' : 'runtime-box';
  return {
    ...row,
    id: normalizeRuntimeBoxServiceId(row.id),
    box_id: row.box_id == null ? null : normalizeRuntimeBoxId(row.box_id),
    runner_kind: runnerKind,
    worker_id: typeof row.worker_id === 'string' ? row.worker_id : null,
  };
}

/** Convert raw PostgreSQL Runtime Box Service rows without mutating query results. */
export function normalizeServiceRows(rows: RawServiceRow[]): ServiceRow[] {
  return rows.map(normalizeServiceRow);
}
