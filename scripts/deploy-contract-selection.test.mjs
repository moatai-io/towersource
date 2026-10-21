import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const list = (...args) => JSON.parse(execFileSync(process.execPath, ['scripts/run-deploy-contract-tests.mjs', ...args, '--list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
test('default retains UI smoke; core removes only frontend tests', () => {
  const full = list().tests;
  const core = list('--core-only').tests;
  assert(full.some(p => p.includes('AgentIdentityAvatar')));
  assert(core.length < full.length);
  assert.deepEqual(core, full.filter(p => !p.startsWith('packages/frontend/')));
  assert(core.some(p => p.includes('operator-prod-upgrade-plan')));
  assert(core.some(p => p.includes('apply-db-migrations')));
});
test('unknown mode fails closed', () => {
  assert.throws(() => list('--skip-everything'));
});

test('deployment runner uses bounded workers and honors verifier limit', () => {
  const selection = list('--core-only');
  assert.equal(selection.maxWorkers, Number(process.env.VITEST_MAX_WORKERS || 4));
  const limited = JSON.parse(execFileSync(process.execPath, ['scripts/run-deploy-contract-tests.mjs', '--list'], { encoding: 'utf8', env: { ...process.env, VITEST_MAX_WORKERS: '2' } }));
  assert.equal(limited.maxWorkers, 2);
});

test('detailed upgrade flow is explicit and default is smoke', () => {
  assert.equal(list().fullUpgradeFlow, false);
  assert.equal(list('--full-upgrade-flow').fullUpgradeFlow, true);
});

test('smoke covers five explicit flow scenarios; filter never touches other files', () => {
  const flow = readFileSync('packages/backend/operator-prod-upgrade-flow.test.ts', 'utf8');
  assert.equal((flow.match(/it\('\[deploy-smoke\]/g) || []).length, 5);
  const { plan } = list();
  assert.equal(plan.checks.length, 2);
  assert(!plan.checks[0].args.some(arg => arg.startsWith('--testNamePattern')));
  assert(!plan.checks[0].args.includes('packages/backend/operator-prod-upgrade-flow.test.ts'));
  assert(plan.checks[1].args.includes('packages/backend/operator-prod-upgrade-flow.test.ts'));
  assert(plan.checks[1].args.some(arg => arg.startsWith('--testNamePattern')));
});
