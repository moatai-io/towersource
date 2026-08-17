import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePgPool, getPgPool, initPg, isPgEnabled } from '../db/pg.js';

const mode = process.argv[2] || 'status';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationDir = path.join(__dirname, '..', 'db', 'migrations');

function migrationFiles(): string[] {
  return fs.readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort();
}

async function status() {
  if (!isPgEnabled()) throw new Error('DATABASE_URL is not set');
  const pool = getPgPool();
  const exists = await pool.query<{ exists: boolean }>("SELECT to_regclass('public._migrations') IS NOT NULL AS exists");
  const applied = new Set<string>();
  if (exists.rows[0]?.exists) {
    const result = await pool.query<{ version: string; name: string | null }>('SELECT version, name FROM _migrations');
    for (const row of result.rows) {
      if (row.version) applied.add(row.version);
      if (row.name) applied.add(row.name.replace(/\.sql$/, ''));
    }
  }
  const pending = migrationFiles().filter((file) => {
    const key = file.replace(/\.sql$/, '');
    const legacy = file.split('_')[0];
    return !applied.has(key) && !applied.has(legacy);
  });
  console.log(JSON.stringify({ status: 'ok', pending, pendingCount: pending.length }));
}

async function main() {
  if (mode === 'status') {
    await status();
  } else if (mode === 'apply') {
    await initPg();
    const pool = getPgPool();
    const result = await pool.query<{ version: string }>('SELECT version FROM _migrations ORDER BY version');
    console.log(JSON.stringify({ status: 'migrated', applied: result.rows.map((row) => row.version), pending: [], pendingCount: 0 }));
  } else {
    throw new Error('usage: apply-db-migrations <status|apply>');
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePgPool().catch(() => {});
  });
