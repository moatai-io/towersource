import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { closePgPool, getPgPool, initPg, isPgEnabled } from '../db/pg.js';
import { compareMigrationHistory, type MigrationHistoryRow } from './migration-history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationDir = path.join(__dirname, '..', 'db', 'migrations');
const usage = 'usage: apply-db-migrations <status [--files-json <path>]|apply>';

function migrationFiles(filesJson?: string): string[] {
  if (!filesJson) return fs.readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort();
  // A candidate revision can supply basenames without checking it out or running
  // its code. This option is read-only and deliberately not accepted by apply.
  const files: unknown = JSON.parse(fs.readFileSync(filesJson, 'utf8'));
  if (!Array.isArray(files) || files.some((file) => (
    typeof file !== 'string' || !file.endsWith('.sql') || /[/\\\u0000]/.test(file)
  ))) {
    throw new Error('--files-json must contain a JSON array of SQL file basenames');
  }
  return [...new Set(files as string[])].sort();
}

async function readHistory(): Promise<MigrationHistoryRow[]> {
  const pool = getPgPool();
  const exists = await pool.query<{ exists: boolean }>("SELECT to_regclass('public._migrations') IS NOT NULL AS exists");
  if (!exists.rows[0]?.exists) return [];
  const result = await pool.query<MigrationHistoryRow>('SELECT version, name FROM _migrations ORDER BY version');
  return result.rows;
}

export async function runMigrationCommand(args: string[] = process.argv.slice(2)): Promise<void> {
  const mode = args[0] || 'status';
  const filesJson = mode === 'status' && args.length === 3 && args[1] === '--files-json' ? args[2] : undefined;
  if (!['status', 'apply'].includes(mode) || (args.length > 1 && !filesJson)) throw new Error(usage);
  if (!isPgEnabled()) throw new Error('DATABASE_URL is not set');
  // Validate the local SQL inventory before any migration writes. Missing build
  // assets must not become an empty inventory / successful apply report.
  const files = migrationFiles(filesJson);
  if (mode === 'apply') await initPg();
  const history = await readHistory();
  const comparison = compareMigrationHistory(files, history);
  if (mode === 'status') {
    console.log(JSON.stringify({ status: 'ok', ...comparison }));
    return;
  }
  const incomplete = comparison.pendingCount > 0;
  console.log(JSON.stringify({
    status: incomplete ? 'incomplete' : 'migrated',
    applied: history.map((row) => row.version),
    ...comparison,
  }));
  if (incomplete) throw new Error(`Migration verification failed: ${comparison.pendingCount} pending migration(s) remain`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runMigrationCommand()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePgPool().catch(() => {});
    });
}
