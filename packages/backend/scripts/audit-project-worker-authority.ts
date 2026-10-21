#!/usr/bin/env node
/**
 * Read-only audit for Project Worker execution/file authority drift.
 *
 * Usage:
 *   npx tsx packages/backend/scripts/audit-project-worker-authority.ts
 *   npx tsx packages/backend/scripts/audit-project-worker-authority.ts --json
 *   npx tsx packages/backend/scripts/audit-project-worker-authority.ts --deployment production --json
 */
import { closePgPool } from '../db/pg.js';
import { auditProjectWorkerAuthority } from '../services/runtime-box/workbench-project-worker-authority-audit.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function deploymentId(): string {
  const value = argument('--deployment') || process.env.TOWER_DEPLOYMENT_ID?.trim() || 'production';
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(value)) throw new Error('PROJECT_COMPUTE_DEPLOYMENT_ID_INVALID');
  return value;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log('Usage: audit-project-worker-authority [--json] [--deployment <id>]');
    return;
  }
  const deployment = deploymentId();
  const findings = await auditProjectWorkerAuthority(deployment);
  const critical = findings.filter(finding => finding.severity === 'critical').length;
  const summary = { ok: findings.length === 0, deploymentId: deployment, count: findings.length, critical, warning: findings.length - critical };
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...summary, findings }, null, 2));
  } else if (findings.length === 0) {
    console.log(`OK: ${deployment} Project Worker authority invariants hold.`);
  } else {
    console.error(`FAIL: ${findings.length} Project Worker authority drift finding(s) (${critical} critical).`);
    for (const finding of findings) {
      console.error(`- [${finding.severity}] ${finding.projectName}(${finding.projectId}): ${finding.problems.join(', ')}`);
    }
  }
  process.exitCode = findings.length === 0 ? 0 : 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }).finally(async () => {
    if (!process.argv.includes('--json')) return closePgPool();
    const log = console.log;
    console.log = () => {};
    try {
      await closePgPool();
    } finally {
      console.log = log;
    }
  });
}
