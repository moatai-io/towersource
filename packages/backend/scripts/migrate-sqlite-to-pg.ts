/**
 * ⚠️ LEGACY — one-time SQLite → PostgreSQL migration.
 *
 * This script belongs to the 3/2026 migration, when Tower still used SQLite
 * as its primary store. The migration has already been run on all known
 * installs. `better-sqlite3` is no longer a dependency, so this file will
 * fail to import in a fresh checkout — that is intentional. Do NOT run this
 * on a new install; there is nothing to migrate from.
 *
 * Kept in-tree as a schema-mapping reference for anyone upgrading from a
 * very old Tower (< v3.0) snapshot. If you need to run it:
 *   1. `npm i -D better-sqlite3` (devDependency only)
 *   2. Point DB_PATH at the old tower.db
 *   3. Point DATABASE_URL at the new PG
 *   4. `npx tsx packages/backend/scripts/migrate-sqlite-to-pg.ts`
 *
 * Safe to run multiple times (uses ON CONFLICT DO NOTHING).
 * Does NOT delete SQLite data.
 */
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

// Load .env
try {
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx);
      const value = trimmed.slice(eqIdx + 1);
      if (!process.env[key]) process.env[key] = value;
    }
  }
} catch {}

const DB_PATH = process.env.DB_PATH || path.join(PROJECT_ROOT, 'data', 'tower.db');
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL not set. Aborting.');
  process.exit(1);
}

if (!fs.existsSync(DB_PATH)) {
  console.error(`SQLite DB not found at ${DB_PATH}. Aborting.`);
  process.exit(1);
}

const sqlite = new Database(DB_PATH, { readonly: true });
const pool = new Pool({ connectionString: DATABASE_URL });

// ── Table definitions (FK dependency order) ──

interface TableDef {
  name: string;
  columns: string[];
  serial?: string; // column name if SERIAL PK needs sequence sync
}

const TABLES: TableDef[] = [
  {
    name: 'users',
    columns: ['id', 'username', 'password_hash', 'password_plain', 'role', 'disabled', 'allowed_path', 'created_at'],
    serial: 'id',
  },
  {
    name: 'projects',
    columns: ['id', 'name', 'description', 'root_path', 'color', 'sort_order', 'collapsed', 'archived', 'user_id', 'created_at'],
  },
  {
    name: 'project_members',
    columns: ['project_id', 'user_id', 'role', 'added_at'],
  },
  {
    name: 'sessions',
    columns: [
      'id', 'claude_session_id', 'name', 'cwd', 'tags', 'favorite', 'user_id',
      'total_cost', 'total_tokens', 'model_used', 'auto_named', 'summary',
      'summary_at_turn', 'turn_count', 'files_edited', 'archived', 'engine',
      'visibility', 'room_id', 'project_id', 'created_at', 'updated_at',
    ],
  },
  {
    name: 'messages',
    columns: ['id', 'session_id', 'role', 'content', 'parent_tool_use_id', 'duration_ms', 'input_tokens', 'output_tokens', 'created_at'],
  },
  {
    name: 'tasks',
    columns: [
      'id', 'title', 'description', 'cwd', 'status', 'session_id', 'sort_order',
      'progress_summary', 'model', 'archived', 'scheduled_at', 'schedule_cron',
      'schedule_enabled', 'workflow', 'parent_task_id', 'worktree_path',
      'project_id', 'room_id', 'triggered_by', 'room_message_id',
      'user_id', 'created_at', 'updated_at', 'completed_at',
    ],
  },
  {
    name: 'pins',
    columns: ['id', 'title', 'file_path', 'file_type', 'pin_type', 'content', 'sort_order', 'user_id', 'created_at'],
    serial: 'id',
  },
  {
    name: 'scripts',
    columns: ['id', 'name', 'code', 'language', 'session_id', 'user_id', 'created_at', 'updated_at'],
    serial: 'id',
  },
  {
    name: 'git_commits',
    columns: ['id', 'hash', 'short_hash', 'author_name', 'message', 'commit_type', 'session_id', 'user_id', 'files_changed', 'created_at'],
    serial: 'id',
  },
  {
    name: 'shares',
    columns: ['id', 'file_path', 'owner_id', 'share_type', 'target_user_id', 'token', 'expires_at', 'revoked', 'created_at'],
  },
  {
    name: 'system_prompts',
    columns: ['id', 'name', 'prompt', 'updated_at'],
    serial: 'id',
  },
  {
    name: 'skill_registry',
    columns: ['id', 'name', 'scope', 'project_id', 'user_id', 'description', 'category', 'content', 'enabled', 'source', 'created_at', 'updated_at'],
  },
  {
    name: 'user_skill_prefs',
    columns: ['user_id', 'skill_id', 'enabled'],
  },
];

// ── Batch insert helper ──

async function migrateTable(table: TableDef) {
  const { name, columns } = table;

  // Check if table exists in SQLite
  const exists = sqlite.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`
  ).get(name);
  if (!exists) {
    console.log(`[skip] ${name}: table not found in SQLite`);
    return 0;
  }

  const rows = sqlite.prepare(`SELECT ${columns.join(',')} FROM ${name}`).all() as any[];
  if (rows.length === 0) {
    console.log(`[skip] ${name}: empty`);
    return 0;
  }

  // Batch in chunks of 500 to avoid parameter limit (PG max ~65535 params)
  const BATCH_SIZE = 500;
  let totalInserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const placeholders = batch.map((_, rowIdx) =>
      `(${columns.map((_, colIdx) => `$${rowIdx * columns.length + colIdx + 1}`).join(',')})`
    ).join(',');

    const values = batch.flatMap(row =>
      columns.map(col => {
        const val = row[col];
        // Normalize empty strings to null for nullable columns
        if (val === '' && col !== 'name' && col !== 'username' && col !== 'password_hash' && col !== 'title' && col !== 'content' && col !== 'code' && col !== 'prompt') {
          return null;
        }
        return val ?? null;
      })
    );

    // Determine conflict target for ON CONFLICT
    const conflictCol = getPrimaryKey(name);
    const conflictClause = conflictCol
      ? `ON CONFLICT (${conflictCol}) DO NOTHING`
      : 'ON CONFLICT DO NOTHING';

    try {
      const result = await pool.query(
        `INSERT INTO ${name} (${columns.join(',')}) VALUES ${placeholders} ${conflictClause}`,
        values,
      );
      totalInserted += result.rowCount ?? 0;
    } catch (err: any) {
      console.error(`[ERROR] ${name} batch ${i}-${i + batch.length}: ${err.message}`);
      // Try row-by-row for this batch to identify the problem row
      for (const row of batch) {
        const singlePlaceholders = `(${columns.map((_, j) => `$${j + 1}`).join(',')})`;
        const singleValues = columns.map(col => row[col] ?? null);
        try {
          await pool.query(
            `INSERT INTO ${name} (${columns.join(',')}) VALUES ${singlePlaceholders} ${conflictClause}`,
            singleValues,
          );
          totalInserted++;
        } catch (rowErr: any) {
          console.error(`  [SKIP ROW] ${name} id=${row.id ?? 'N/A'}: ${rowErr.message}`);
        }
      }
    }
  }

  console.log(`[migrated] ${name}: ${totalInserted}/${rows.length} rows`);
  return totalInserted;
}

function getPrimaryKey(tableName: string): string {
  const pkMap: Record<string, string> = {
    users: 'id',
    projects: 'id',
    project_members: 'project_id, user_id',
    sessions: 'id',
    messages: 'id',
    tasks: 'id',
    pins: 'id',
    scripts: 'id',
    git_commits: 'id',
    shares: 'id',
    system_prompts: 'id',
    skill_registry: 'id',
    user_skill_prefs: 'user_id, skill_id',
  };
  return pkMap[tableName] || 'id';
}

// ── Sync SERIAL sequences ──

async function syncSequences() {
  const serialTables = TABLES.filter(t => t.serial);
  for (const table of serialTables) {
    try {
      await pool.query(
        `SELECT setval(pg_get_serial_sequence('${table.name}', '${table.serial}'), COALESCE((SELECT MAX(${table.serial}) FROM ${table.name}), 0) + 1, false)`
      );
      console.log(`[seq] ${table.name}.${table.serial} synced`);
    } catch (err: any) {
      console.error(`[seq-error] ${table.name}: ${err.message}`);
    }
  }
}

// ── Verify counts ──

async function verify() {
  console.log('\n--- Verification ---');
  let allMatch = true;

  for (const table of TABLES) {
    const exists = sqlite.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`
    ).get(table.name);
    if (!exists) continue;

    const sqliteCount = (sqlite.prepare(`SELECT COUNT(*) as cnt FROM ${table.name}`).get() as any).cnt;
    const pgResult = await pool.query(`SELECT COUNT(*) as cnt FROM ${table.name}`);
    const pgCount = parseInt(pgResult.rows[0].cnt);
    const match = sqliteCount === pgCount;
    if (!match) allMatch = false;
    console.log(`  ${table.name}: SQLite=${sqliteCount} PG=${pgCount} ${match ? 'OK' : 'MISMATCH!'}`);
  }

  return allMatch;
}

// ── Main ──

async function main() {
  console.log(`SQLite: ${DB_PATH}`);
  console.log(`PG: ${DATABASE_URL?.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`\n--- Migrating ${TABLES.length} tables ---\n`);

  const start = Date.now();

  for (const table of TABLES) {
    await migrateTable(table);
  }

  await syncSequences();
  const allMatch = await verify();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s. ${allMatch ? 'All counts match.' : 'WARNING: Some counts differ — check above.'}`);

  sqlite.close();
  await pool.end();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
