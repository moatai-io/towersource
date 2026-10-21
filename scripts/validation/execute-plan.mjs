import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// Small runner, not a workflow engine. No shell interpolation, retries or skips.
export function executePlan(plan, { spawn = spawnSync, record = recordObservation, now = () => performance.now() } = {}) {
  if (plan.version !== 1 || !Array.isArray(plan.checks) || !plan.checks.length) throw new Error('Invalid validation plan');
  for (const check of plan.checks) {
    if (!check.id || !check.command || !Array.isArray(check.args) || check.args.some(arg => typeof arg !== 'string')) throw new Error('Invalid check');
  }
  const runId = randomUUID();
  const planHash = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  for (const check of plan.checks) {
    const start = now();
    let result;
    try { result = spawn(check.command, check.args, { stdio: 'inherit', shell: false }); }
    catch { result = { status: null, error: true }; }
    const status = executionStatus(result);
    // Observations cannot turn failures into passes or block successful checks.
    try { record({ version: 2, runId, planHash, sourceRevision: plan.sourceRevision ?? null, workingTree: plan.workingTree ?? 'unknown', timestamp: new Date().toISOString(), checkId: check.id, durationMs: Math.round(now() - start), status, exitCode: result?.status ?? null, coreOnly: plan.coreOnly, fullUpgradeFlow: plan.fullUpgradeFlow, maxWorkers: plan.maxWorkers }); }
    catch { console.warn('Validation observation could not be saved; check result is unchanged.'); }
    if (status !== 'passed') return result?.status || 1;
  }
  return 0;
}
function recordObservation(event) {
  const file = process.env.TOWER_VALIDATION_OBSERVATIONS;
  if (file) appendFileSync(file, JSON.stringify(event) + '\n', { mode: 0o600 });
}

function executionStatus(result) {
  if (result?.error || result?.signal || !Number.isInteger(result?.status)) return 'execution-error';
  return result.status === 0 ? 'passed' : 'failed';
}

// Pure plan construction: selection and execution stay separate.
export function deploymentPlan({ tests, coreOnly = false, fullUpgradeFlow = false, maxWorkers = 4, sourceRevision = null, workingTree = 'unknown' }) {
  const flow = 'packages/backend/operator-prod-upgrade-flow.test.ts';
  const check = (id, files, extra = []) => ({ id, command: 'npx', args: ['vitest', 'run', `--maxWorkers=${maxWorkers}`, ...files, ...extra] });
  const checks = fullUpgradeFlow
    ? [check('deployment-full', tests)]
    : [check('deployment-contracts', tests.filter(file => file !== flow)), check('upgrade-smoke', [flow], ['--testNamePattern=\\[deploy-smoke\\]'])];
  return { version: 1, sourceRevision, workingTree, coreOnly, fullUpgradeFlow, maxWorkers, checks };
}
