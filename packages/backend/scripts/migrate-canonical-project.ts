#!/usr/bin/env node
/** Dry-run by default. Apply requires the exact plan file and its approved hash. */
import fs from 'node:fs';
import path from 'node:path';
import { closePgPool } from '../db/pg.js';
import { applyCanonicalProjectMigration, planCanonicalProjectMigration, type CanonicalProjectMigrationPlan } from '../services/project-environment/canonical-project-migration.js';

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === 'plan') {
    const projectId = value('--project');
    const output = value('--output');
    if (!projectId || !output) throw new Error('Usage: migrate-canonical-project plan --project <id> --output <new-file> [--deployment production]');
    const target = path.resolve(output);
    const plan = await planCanonicalProjectMigration({ projectId, deploymentId: value('--deployment') });
    fs.writeFileSync(target, `${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ status: 'planned', projectId, planHash: plan.planHash, planFile: target, aclChanges: plan.aclChanges.length, storageAction: plan.storageAction }));
    return;
  }
  if (action === 'apply') {
    const planFile = value('--plan');
    const approvedHash = value('--approve-plan');
    const receiptDirectory = value('--receipt-dir');
    if (!planFile || !approvedHash || !receiptDirectory) throw new Error('Usage: migrate-canonical-project apply --plan <file> --approve-plan <sha256> --receipt-dir <owner-only-dir>');
    const plan = JSON.parse(fs.readFileSync(path.resolve(planFile), 'utf8')) as CanonicalProjectMigrationPlan;
    console.log(JSON.stringify(await applyCanonicalProjectMigration({ plan, approvedHash, receiptDirectory })));
    return;
  }
  throw new Error('Usage: migrate-canonical-project <plan|apply> ...');
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'failed', error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}).finally(() => closePgPool());
