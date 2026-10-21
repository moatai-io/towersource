import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePgPool, getPgPool, isPgEnabled } from '../db/pg.js';
import { evaluateLegacyCustomerMappingRetirement } from './legacy-customer-mapping-retirement-policy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const activeSources = [
  'packages/backend/services',
  'packages/backend/routes',
  'packages/backend/mcp',
  'packages/backend/engines',
  'packages/frontend/src',
];

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative);
    return /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.|\.source\.test\.|\.e2e\.test\.|\.integration\.test\./.test(entry.name) ? [relative] : [];
  });
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

async function scalar(sql: string): Promise<number> {
  const result = await getPgPool().query<{ count: string }>(sql);
  return Number(result.rows[0]?.count ?? 0);
}

async function main(): Promise<void> {
  if (!isPgEnabled()) throw new Error('DATABASE_URL is not set');
  const pool = getPgPool();
  const table = await pool.query<{ exists: boolean }>("SELECT to_regclass('public.user_customer_vms') IS NOT NULL AS exists");
  const tableExists = Boolean(table.rows[0]?.exists);
  const migration = await pool.query<{ applied_at: string }>(
    `SELECT applied_at::text
       FROM _migrations
      WHERE version IN ('191', '191_remove_customer_manager_role')
         OR name = '191_remove_customer_manager_role.sql'
      ORDER BY applied_at DESC
      LIMIT 1`,
  );
  const references = activeSources.flatMap(sourceFiles).filter(file => fs.readFileSync(path.join(root, file), 'utf8').includes('user_customer_vms'));
  const report = evaluateLegacyCustomerMappingRetirement({
    tableExists,
    migration191AppliedAt: migration.rows[0]?.applied_at ?? null,
    legacyUserRoleCount: await scalar("SELECT COUNT(*) FROM users WHERE role = 'customer_manager'"),
    legacyInviteRoleCount: await scalar("SELECT COUNT(*) FROM signup_invite_codes WHERE default_role = 'customer_manager'"),
    mappingRowCount: tableExists ? await scalar('SELECT COUNT(*) FROM user_customer_vms') : 0,
    activeSourceReferences: references,
    compatibilityReleaseConfirmed: flag('--confirm-compatibility-release'),
    mappingArchiveConfirmed: flag('--confirm-mapping-archive'),
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready) process.exitCode = 2;
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => closePgPool().catch(() => {}));
