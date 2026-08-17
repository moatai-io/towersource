/**
 * PostgreSQL connection pool + migration runner.
 *
 * Primary database. Sessions, projects, users, chat rooms, search indexes, and
 * every other persistent state live here. SQLite was retired in the 3/2026
 * migration (see scripts/migrate-sqlite-to-pg.ts — one-shot legacy tool).
 *
 * Extensions required: pg_trgm, pgvector, uuid-ossp.
 */

import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let pool: Pool | null = null;

export function getPgPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set. Chat rooms require PostgreSQL.');
    }
    // Pool size raised 20 → 50 → 80 (2026-04-10 decision: realtime-sync-and-scale,
    // then 100-user scale follow-up the same day).
    // Rationale: at 100 concurrent users with active rooms, each room message fans out
    // to member queries + notification inserts. At max=50 the connection queue still
    // saturated under admin sidebar loads (listRooms N+1) + simultaneous message writes.
    // idleTimeout and connectionTimeout raised to absorb burst latency.
    pool = new Pool({
      connectionString,
      max: 80,                        // connection pool size (100-user target)
      idleTimeoutMillis: 45000,       // keep warm connections longer under burst load
      connectionTimeoutMillis: 8000,  // allow slower acquires before erroring out
    });

    pool.on('error', (err) => {
      console.error('[pg] Unexpected pool error:', err.message);
    });
  }
  return pool;
}

/** Graceful shutdown — call from process exit handler. */
export async function closePgPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('[pg] Pool closed.');
  }
}

/** Check if PG is configured (DATABASE_URL exists). */
export function isPgEnabled(): boolean {
  return !!process.env.DATABASE_URL;
}

const MANAGED_DEFERRED_MIGRATION_PREFIXES = ['158_turn_file_checkpoints', '159_messages_message_seq'] as const;

export function shouldDeferMigrationForVm(file: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TOWER_ROLE !== 'managed') return false;
  if (env.TOWER_TURN_REWIND_ENABLED !== 'false') return false;
  const fileKey = file.replace(/\.sql$/, '');
  return MANAGED_DEFERRED_MIGRATION_PREFIXES.some((prefix) => fileKey === prefix || fileKey.startsWith(`${prefix}_`));
}

/**
 * Initialize PG: create _migrations table, run extensions, apply pending migrations.
 * Safe to call multiple times (idempotent).
 */
export async function initPg(): Promise<void> {
  if (!isPgEnabled()) {
    console.log('[pg] DATABASE_URL not set — chat rooms disabled.');
    return;
  }

  const p = getPgPool();

  // Test connection
  try {
    const res = await p.query('SELECT NOW()');
    console.log(`[pg] Connected to PostgreSQL at ${new Date(res.rows[0].now).toISOString()}`);
  } catch (err: any) {
    console.error(`[pg] Connection failed: ${err.message}`);
    throw err;
  }

  // Ensure _migrations table
  await p.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         SERIAL PRIMARY KEY,
      version    TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Ensure extensions (requires superuser or pre-created)
  try {
    await p.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await p.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);
  } catch (err: any) {
    // Extensions may already exist or require superuser — log but don't fail
    console.warn(`[pg] Extension warning (safe to ignore if already created): ${err.message}`);
  }

  // Run pending migrations
  //
  // Versioning rules (see workspace/decisions/2026-04-21-pg-migration-runner-unique-key-fix.md):
  //   • New version key = full filename without `.sql` (e.g. `018_claude_accounts`).
  //     This lets two files share a numeric prefix (`018_claude_accounts.sql`
  //     and `018_session_labels.sql`) without colliding on the UNIQUE
  //     constraint of `_migrations.version`.
  //   • Backward compat: older deployments stored a 3-digit prefix
  //     (`018`). We also check the legacy prefix in `appliedSet`, and seed
  //     the set from both `version` and `name` columns so a server upgraded
  //     in-place never re-runs a migration.
  const { rows: applied } = await p.query('SELECT version, name FROM _migrations');
  const appliedSet = new Set<string>();
  for (const row of applied as Array<{ version: string; name?: string | null }>) {
    if (row.version) appliedSet.add(row.version);
    if (row.name) appliedSet.add(row.name.replace(/\.sql$/, ''));
  }

  const migrationDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationDir)) {
    console.log('[pg] No migrations directory found — skipping.');
    return;
  }

  const files = fs.readdirSync(migrationDir)
    .filter(f => f.endsWith('.sql'))
    .sort();
  const deferredFiles = files.filter((file) => shouldDeferMigrationForVm(file));
  if (deferredFiles.length > 0) {
    console.log(`[pg-migration] Deferred on self-hosted VM because TOWER_TURN_REWIND_ENABLED=false: ${deferredFiles.join(', ')}`);
  }

  const isApplied = (file: string): boolean => {
    const fileKey = file.replace(/\.sql$/, '');   // "018_claude_accounts"
    const legacyKey = file.split('_')[0];          // "018" (pre-2026-04-21)
    return appliedSet.has(fileKey) || appliedSet.has(legacyKey);
  };

  for (const file of files) {
    if (isApplied(file) || shouldDeferMigrationForVm(file)) continue;

    const fileKey = file.replace(/\.sql$/, '');
    const sql = fs.readFileSync(path.join(migrationDir, file), 'utf8');
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO _migrations (version, name) VALUES ($1, $2)',
        [fileKey, file],
      );
      await client.query('COMMIT');
      // Guard the in-memory set too, so the next iteration of this run
      // sees the INSERT even before the next pool round-trip.
      appliedSet.add(fileKey);
      console.log(`[pg-migration] ✅ ${file}`);
    } catch (err: any) {
      await client.query('ROLLBACK');
      console.error(`[pg-migration] ❌ ${file}: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }

  const pendingCount = files.filter(f => !isApplied(f) && !shouldDeferMigrationForVm(f)).length;
  if (pendingCount === 0) {
    console.log('[pg] All migrations up to date.');
  }
}
