import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deploymentPlan, executePlan } from './execute-plan.mjs';
const plan = { version: 1, checks: [{ id: 'first', command: 'fixture', args: [] }, { id: 'second', command: 'fixture', args: [] }] };
test('records successful and failed checks, then stops without retry', () => {
  const events = []; let calls = 0;
  assert.equal(executePlan(plan, { spawn: () => ({ status: ++calls === 1 ? 0 : 7 }), record: event => events.push(event) }), 7);
  assert.equal(calls, 2); assert.deepEqual(events.map(e => e.status), ['passed', 'failed']);
});
test('telemetry failure does not change result', () => {
  assert.equal(executePlan(plan, { spawn: () => ({ status: 0 }), record: () => { throw Error(); } }), 0);
});
test('launch failure fails closed and does not run later checks', () => {
  let calls = 0;
  assert.equal(executePlan(plan, { spawn: () => { calls++; throw Error(); }, record: () => {} }), 1); assert.equal(calls, 1);
});
test('validates entire plan before executing', () => {
  let calls = 0;
  assert.throws(() => executePlan({ version: 1, checks: [...plan.checks, {}] }, { spawn: () => { calls++; } })); assert.equal(calls, 0);
});

test('pure plan preserves smoke partition and full coverage', () => {
 const flow = 'packages/backend/operator-prod-upgrade-flow.test.ts';
 const tests = ['fixture.test.ts', flow];
 const smoke = deploymentPlan({ tests });
 assert.deepEqual(smoke.checks[0].args, ['vitest', 'run', '--maxWorkers=4', 'fixture.test.ts']);
 assert(smoke.checks[1].args.includes(flow));
 const full = deploymentPlan({ tests, fullUpgradeFlow: true });
 assert.equal(full.checks.length, 1);
 assert.deepEqual(full.checks[0].args, ['vitest', 'run', '--maxWorkers=4', ...tests]);
 assert.deepEqual(tests, ['fixture.test.ts', flow]);
});
test('malformed subprocess result fails closed', () => {
 assert.equal(executePlan(plan, { spawn: () => undefined, record: () => {} }), 1);
});
