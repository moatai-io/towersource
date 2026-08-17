import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePgPool } from '../../db/pg.js';
import { query, queryOne } from '../../db/pg-repo.js';
import { applyWorkbenchToolChange, previewWorkbenchToolChange, type WorkbenchToolCommandDependencies } from './workbench-tool-commands.js';
import { inspectWorkbenchTools, type WorkbenchToolManifest } from './workbench-tools.js';

const runFile = promisify(execFile);
const enabled = process.env.WORKBENCH_TOOL_E2E === '1';
const run = enabled ? describe : describe.skip;

async function docker(...args: string[]) {
  return runFile('docker', args, { maxBuffer: 2_000_000 });
}

run('Workbench tool PostgreSQL concurrent apply E2E', () => {
  const pgName = `tower-workbench-concurrency-pg-${process.pid}`;
  const projectId = 'project-concurrency-e2e';
  const sessionId = 'session-concurrency-e2e';
  const actor = { userId: 17, role: 'operator', sessionId };
  let root = '';
  let pgPort = 0;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-workbench-concurrency-e2e-'));
    pgPort = 27000 + (process.pid % 1000);
    await docker('run', '-d', '--rm', '--name', pgName, '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=tower_test', '-p', `127.0.0.1:${pgPort}:5432`, 'postgres:16-alpine');
    for (let i = 0; i < 40; i += 1) {
      try {
        await runFile('psql', [`postgresql://postgres:test@127.0.0.1:${pgPort}/tower_test`, '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1']);
        break;
      } catch {
        if (i === 39) throw new Error('Disposable PostgreSQL did not become ready');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    process.env.DATABASE_URL = `postgresql://postgres:test@127.0.0.1:${pgPort}/tower_test`;
    const migrationRoot = path.resolve(process.cwd(), 'packages/backend/db/migrations');
    for (const file of ['007_users.sql', '008_sessions.sql', '009_projects.sql']) {
      await runFile('psql', [process.env.DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-f', path.join(migrationRoot, file)]);
    }
    await runFile('psql', [process.env.DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-c',
      `INSERT INTO users(id,username,password_hash,role) VALUES(17,'operator-concurrency','x','operator');
       INSERT INTO projects(id,name,root_path,user_id) VALUES('${projectId}','Concurrency E2E','${root.replaceAll("'", "''")}',17);
       INSERT INTO sessions(id,name,user_id,project_id) VALUES('${sessionId}','Concurrency E2E',17,'${projectId}');`]);
    for (const file of ['150_runtime_box_workbench_tool_revisions.sql', '151_runtime_box_workbench_tool_commands.sql']) {
      await runFile('psql', [process.env.DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-f', path.join(migrationRoot, file)]);
    }
  }, 120_000);

  afterAll(async () => {
    await closePgPool().catch(() => undefined);
    await docker('rm', '-f', pgName).catch(() => undefined);
    if (root) await fs.rm(root, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
  });

  async function resetState() {
    await query('TRUNCATE runtime_box_workbench_tool_commands, runtime_box_workbench_tool_change_intents, runtime_box_workbench_tool_revisions, runtime_box_workbench_tool_states CASCADE');
    await fs.rm(path.join(root, '.runtime-box'), { recursive: true, force: true });
  }

  function dependencies(mutationCalls: string[], delayMs = 80): WorkbenchToolCommandDependencies {
    return {
      inspect: inspectWorkbenchTools,
      install: async input => {
        mutationCalls.push(input.actor.jobId ?? 'unknown');
        await new Promise(resolve => setTimeout(resolve, delayMs));
        const current = await queryOne<{ current_revision: number | null }>(
          'SELECT current_revision FROM runtime_box_workbench_tool_states WHERE project_id=$1', [projectId],
        );
        const previousRevision = current?.current_revision == null ? null : Number(current.current_revision);
        if (input.expectedRevision !== undefined && previousRevision !== input.expectedRevision) throw new Error('Workbench tool revision conflict');
        const revision = previousRevision == null ? 1 : previousRevision + 1;
        await queryOne(
          `INSERT INTO runtime_box_workbench_tool_states(project_id,current_revision,health,updated_by_user_id,updated_by_session_id)
           VALUES($1,NULL,'healthy',$2,$3)
           ON CONFLICT(project_id) DO NOTHING RETURNING project_id`, [projectId, actor.userId, actor.sessionId],
        );
        await queryOne(
          `INSERT INTO runtime_box_workbench_tool_revisions
             (project_id,revision,state,previous_revision,manager,manifest,manifest_hash,prefix_relpath,validation,reason,job_id,session_id,requested_by_user_id,activated_at)
           VALUES($1,$2,'active',$3,'uv-tool',$4::jsonb,$5,$6,'{}'::jsonb,'concurrency-e2e',$7,$8,$9,NOW()) RETURNING revision`,
          [projectId, revision, previousRevision, JSON.stringify({ revision }), 'a'.repeat(64), `.runtime-box/workbench-tools/revisions/${String(revision).padStart(6, '0')}`, input.actor.jobId, actor.sessionId, actor.userId],
        );
        await queryOne(
          `UPDATE runtime_box_workbench_tool_states SET current_revision=$2,updated_at=NOW() WHERE project_id=$1 RETURNING project_id`,
          [projectId, revision],
        );
        const revisionRoot = path.join(root, '.runtime-box', 'workbench-tools', 'revisions', String(revision).padStart(6, '0'));
        await fs.mkdir(revisionRoot, { recursive: true });
        const active = path.join(root, '.runtime-box', 'workbench-tools', 'active');
        await fs.rm(active, { force: true });
        await fs.symlink(`revisions/${String(revision).padStart(6, '0')}`, active);
        return { revision } as WorkbenchToolManifest;
      },
      rollback: async () => { throw new Error('not used'); },
    };
  }

  const action = { kind: 'install' as const, manager: 'uv-tool' as const, tool: { name: 'ruff', version: '0.12.0', entrypoints: ['ruff'] } };

  it('applies the same intent once and reuses the stored result after a service restart boundary', async () => {
    await resetState();
    const mutationCalls: string[] = [];
    const deps = dependencies(mutationCalls);
    const preview = await previewWorkbenchToolChange({ projectId, projectRoot: root, expectedRevision: null, action, reason: 'same intent', actor });
    const request = {
      projectId, projectRoot: root, intentId: preview.intentId, proposalHash: preview.proposalHash, expectedRevision: null,
      idempotencyKey: 'same-intent-key', confirmed: true as const, actor, dependencies: deps,
    };
    const [first, second] = await Promise.all([applyWorkbenchToolChange(request), applyWorkbenchToolChange(request)]);
    expect(first).toEqual({ revision: 1 });
    expect(second).toEqual(first);
    expect(mutationCalls).toHaveLength(1);
    expect((await queryOne<{ count: string }>('SELECT COUNT(*)::text AS count FROM runtime_box_workbench_tool_revisions WHERE project_id=$1', [projectId]))?.count).toBe('1');

    await closePgPool();
    const afterRestart = await applyWorkbenchToolChange({ ...request, dependencies: dependencies(mutationCalls, 0) });
    expect(afterRestart).toEqual({ revision: 1 });
    expect(mutationCalls).toHaveLength(1);
  }, 30_000);

  it('allows only one of two intents with different keys and the same expected revision to mutate', async () => {
    await resetState();
    const mutationCalls: string[] = [];
    const deps = dependencies(mutationCalls, 120);
    const [previewA, previewB] = await Promise.all([
      previewWorkbenchToolChange({ projectId, projectRoot: root, expectedRevision: null, action, reason: 'race a', actor }),
      previewWorkbenchToolChange({ projectId, projectRoot: root, expectedRevision: null, action, reason: 'race b', actor }),
    ]);
    const settled = await Promise.allSettled([
      applyWorkbenchToolChange({ projectId, projectRoot: root, intentId: previewA.intentId, proposalHash: previewA.proposalHash, expectedRevision: null, idempotencyKey: 'race-key-a', confirmed: true, actor, dependencies: deps }),
      applyWorkbenchToolChange({ projectId, projectRoot: root, intentId: previewB.intentId, proposalHash: previewB.proposalHash, expectedRevision: null, idempotencyKey: 'race-key-b', confirmed: true, actor, dependencies: deps }),
    ]);
    expect(settled.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(item => item.status === 'rejected')).toHaveLength(1);
    expect(mutationCalls).toHaveLength(2);
    expect((await queryOne<{ count: string }>('SELECT COUNT(*)::text AS count FROM runtime_box_workbench_tool_revisions WHERE project_id=$1', [projectId]))?.count).toBe('1');
    expect((await queryOne<{ current_revision: number }>('SELECT current_revision FROM runtime_box_workbench_tool_states WHERE project_id=$1', [projectId]))?.current_revision).toBe(1);
    const statuses = await query<{ status: string }>('SELECT status FROM runtime_box_workbench_tool_commands ORDER BY created_at');
    expect(statuses.map(row => row.status).sort()).toEqual(['recovery_required', 'succeeded']);
  }, 30_000);
});
