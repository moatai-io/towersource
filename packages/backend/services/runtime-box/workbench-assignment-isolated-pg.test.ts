import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import pg from 'pg';
import { activateProjectWorkerFirstWithClient } from './workbench-project-worker-first-activation.js';

// No production connection is allowed; this suite requires a private Unix socket.
vi.mock('../../db/pg-repo.js', () => ({ transaction: vi.fn() }));
const socket = process.env.ASSIGNMENT_TEST_SOCKET;
const enabled = Boolean(socket?.startsWith(process.cwd() + '/work/'));
let a: pg.Client;
let b: pg.Client;
beforeAll(async () => {
  if (!enabled) return;
  const config = { host: socket!, port: 55489, database: 'postgres', user: 'assignment_test' };
  a = new pg.Client(config); b = new pg.Client(config);
  await a.connect(); await b.connect();
  await a.query(`
    CREATE TABLE project_compute_deployment_bindings (
      project_id text, deployment_id text, default_worker_id text, workstation_mode boolean,
      authority_mode text, updated_by_user_id integer, updated_at timestamptz,
      PRIMARY KEY(project_id,deployment_id));
    CREATE TABLE project_compute_settings (
      project_id text PRIMARY KEY, default_worker_id text, workstation_mode boolean,
      authority_mode text, updated_by_user_id integer, updated_at timestamptz);
    CREATE TABLE runtime_box_workbench_rollouts (
      project_id text PRIMARY KEY, status text, cohort text, reason text, config_json jsonb,
      updated_by_user_id integer, enabled_at timestamptz, disabled_at timestamptz, updated_at timestamptz,
      CHECK(reason <> 'inject-failure'));
  `);
});
afterAll(async () => { if (enabled) await Promise.all([a.end(), b.end()]); });
const input = { projectId: 'demo', deploymentId: 'production', workerId: 'primary', actorUserId: 1,
  reason: 'test', fileAuthorityReady: true, verificationEvidence: 'worker-file-roundtrip' as const, requireUnbound: true };

it.skipIf(!enabled)('serializes competing insert-only activations without replacing the winner', async () => {
  await a.query('BEGIN'); await b.query('BEGIN');
  await activateProjectWorkerFirstWithClient(a, input);
  // Attach rejection handler before releasing the winning transaction.
  const loser = activateProjectWorkerFirstWithClient(b, { ...input, workerId: 'other' }).then(
    () => 'unexpected success', e => e.message);
  await a.query('COMMIT');
  expect(await loser).toBe('ASSIGNMENT_EXISTING_BINDING_REQUIRES_EXPLICIT_CHANGE');
  await b.query('ROLLBACK');
  const r = await a.query('SELECT default_worker_id FROM project_compute_deployment_bindings');
  expect(r.rows).toEqual([{ default_worker_id: 'primary' }]);
  expect((await a.query('SELECT default_worker_id FROM project_compute_settings')).rows)
    .toEqual([{ default_worker_id: 'primary' }]);
});
it.skipIf(!enabled)('rolls back binding and settings when the companion rollout write fails', async () => {
  await a.query('BEGIN');
  await expect(activateProjectWorkerFirstWithClient(a, { ...input, projectId: 'failed-demo', reason: 'inject-failure' }))
    .rejects.toThrow();
  await a.query('ROLLBACK');
  for (const table of ['project_compute_deployment_bindings', 'project_compute_settings', 'runtime_box_workbench_rollouts']) {
    expect((await a.query(`SELECT project_id FROM ${table} WHERE project_id=$1`, ['failed-demo'])).rows).toEqual([]);
  }
});
