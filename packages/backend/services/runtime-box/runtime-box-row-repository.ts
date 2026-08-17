import { query, queryOne } from '../../db/pg-repo.js';
import {
  normalizeBoxRow,
  normalizeBoxRows,
  normalizeServiceRow,
  normalizeServiceRows,
  type RawBoxRow,
  type RawServiceRow,
} from './runtime-box-row-normalization.js';
import type { BoxRow, ServiceRow } from './types.js';

/** Query one persisted Runtime Box and normalize PostgreSQL BIGINT fields immediately. */
export async function queryBoxOne(sql: string, params: any[] = []): Promise<BoxRow | undefined> {
  const row = await queryOne<RawBoxRow>(sql, params);
  return row ? normalizeBoxRow(row) : undefined;
}

/** Query persisted Runtime Boxes and normalize PostgreSQL BIGINT fields immediately. */
export async function queryBoxes(sql: string, params: any[] = []): Promise<BoxRow[]> {
  return normalizeBoxRows(await query<RawBoxRow>(sql, params));
}

/** Query one persisted Runtime Box Service and normalize PostgreSQL BIGINT fields immediately. */
export async function queryServiceOne(sql: string, params: any[] = []): Promise<ServiceRow | undefined> {
  const row = await queryOne<RawServiceRow>(sql, params);
  return row ? normalizeServiceRow(row) : undefined;
}

/** Query persisted Runtime Box Services and normalize PostgreSQL BIGINT fields immediately. */
export async function queryServices(sql: string, params: any[] = []): Promise<ServiceRow[]> {
  return normalizeServiceRows(await query<RawServiceRow>(sql, params));
}
