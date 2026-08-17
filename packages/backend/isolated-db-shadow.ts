import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveIsolatedDbShadowConfig } from './services/isolated-db-shadow-contract.js';

export interface IsolatedDbProbeReport {
  status: 'ok';
  runMode: 'shadow';
  shadowProfile: 'isolated-db';
  authority: 'migration-only';
  databaseHost: string;
  databasePort: number;
  databaseName: string;
  databaseUser: string;
  marker: string;
  migrationCount: number;
  appliedCount: number;
  migrationVersions: string[];
}

interface DbClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
  release(): void;
}

interface DbPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
  connect(): Promise<DbClient>;
  end(): Promise<void>;
}

function migrationFiles(dir: string): string[] {
  const files = fs.readdirSync(dir).filter((file) => file.endsWith('.sql')).sort();
  if (files.length === 0) throw new Error(`No SQL migrations found: ${dir}`);
  return files;
}

/**
 * Apply package migrations only after the DB proves its marker-bound identity.
 * This is intentionally not initPg(): it does not seed users/projects/channels,
 * start a server, schedule cleanup, or initialize any application service.
 */
export async function runIsolatedDbMigrationProbe(
  env: NodeJS.ProcessEnv = process.env,
): Promise<IsolatedDbProbeReport> {
  const config = resolveIsolatedDbShadowConfig(env);
  const files = migrationFiles(config.migrationDir);

  // Dynamic import happens only after the pure guard has rejected production-like env.
  const { Pool } = await import('pg');
  const pool: DbPool = new Pool({
    connectionString: config.databaseUrl,
    max: 1,
    idleTimeoutMillis: 1000,
    connectionTimeoutMillis: 3000,
    application_name: `tower-phase5c-${config.marker}`,
  }) as unknown as DbPool;

  try {
    const identity = await pool.query(
      `SELECT current_database() AS database,
              current_user AS role,
              current_setting('tower.shadow_marker', true) AS marker,
              current_setting('server_version_num')::int AS server_version_num,
              pg_is_in_recovery() AS in_recovery`,
    );
    const row = identity.rows[0];
    if (!row
      || row.database !== config.databaseName
      || row.role !== config.databaseUser
      || row.marker !== config.marker
      || row.in_recovery !== false) {
      throw new Error('Isolated DB runtime identity did not match the fail-closed contract');
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        version TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);

    const existing = await pool.query('SELECT version, name FROM _migrations');
    const applied = new Set<string>();
    for (const item of existing.rows) {
      if (item.version) applied.add(item.version);
      if (item.name) applied.add(String(item.name).replace(/\.sql$/, ''));
    }

    const versions: string[] = [];
    for (const file of files) {
      const fileKey = file.replace(/\.sql$/, '');
      const legacyKey = file.split('_')[0];
      if (applied.has(fileKey) || applied.has(legacyKey)) continue;
      const sql = fs.readFileSync(path.join(config.migrationDir, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO _migrations (version, name) VALUES ($1, $2)', [fileKey, file]);
        await client.query('COMMIT');
        applied.add(fileKey);
        versions.push(fileKey);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    const ledger = await pool.query('SELECT version FROM _migrations ORDER BY version');
    const ledgerVersions = ledger.rows.map((item) => String(item.version));
    for (const file of files) {
      const fileKey = file.replace(/\.sql$/, '');
      const legacyKey = file.split('_')[0];
      if (!ledgerVersions.includes(fileKey) && !ledgerVersions.includes(legacyKey)) {
        throw new Error(`Migration ledger is incomplete: ${file}`);
      }
    }

    return {
      status: 'ok',
      runMode: 'shadow',
      shadowProfile: 'isolated-db',
      authority: 'migration-only',
      databaseHost: config.databaseHost,
      databasePort: config.databasePort,
      databaseName: config.databaseName,
      databaseUser: config.databaseUser,
      marker: config.marker,
      migrationCount: files.length,
      appliedCount: versions.length,
      migrationVersions: versions,
    };
  } finally {
    await pool.end();
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  runIsolatedDbMigrationProbe()
    .then((report) => console.log(JSON.stringify(report)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
