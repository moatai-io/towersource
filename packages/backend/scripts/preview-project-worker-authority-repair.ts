#!/usr/bin/env node
/** Read-only repair preview. This script never changes DB rows or files. */
import { closePgPool } from '../db/pg.js';
import { previewProjectWorkerAuthorityRepairs } from '../services/runtime-box/workbench-project-worker-authority-repair-preview.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log('Usage: preview-project-worker-authority-repair [--json] [--deployment <id>]');
    return;
  }
  const deploymentId = argument('--deployment') || process.env.TOWER_DEPLOYMENT_ID?.trim() || 'production';
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(deploymentId)) throw new Error('PROJECT_COMPUTE_DEPLOYMENT_ID_INVALID');
  const previews = await previewProjectWorkerAuthorityRepairs(deploymentId);
  const summary = {
    ok: !previews.some(item => item.disposition !== 'no_action'),
    deploymentId,
    count: previews.length,
    safeHostFallback: previews.filter(item => item.disposition === 'safe_host_fallback').length,
    manualReview: previews.filter(item => item.disposition === 'manual_review').length,
    noAction: previews.filter(item => item.disposition === 'no_action').length,
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify({ ...summary, previews }, null, 2));
  else {
    console.log(`Preview: ${summary.safeHostFallback} safe host fallback, ${summary.manualReview} manual review, ${summary.noAction} warning-only.`);
    for (const item of previews.filter(value => value.disposition !== 'no_action')) {
      console.log(`- [${item.disposition}] ${item.projectName}(${item.projectId}): ${item.reasons.join('; ')}`);
    }
  }
  process.exitCode = summary.ok ? 0 : 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }).finally(async () => {
    if (!process.argv.includes('--json')) return closePgPool();
    const log = console.log;
    console.log = () => {};
    try { await closePgPool(); } finally { console.log = log; }
  });
}
