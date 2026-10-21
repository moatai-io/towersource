import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runFile = promisify(execFile);
const run = process.env.WORKBENCH_BACKUP_E2E === '1' ? describe : describe.skip;
async function docker(...args: string[]) { return runFile('docker', args, { maxBuffer: 4_000_000 }); }

run('Workbench minimal backup/restore PostgreSQL + filesystem E2E', () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const pgName = `tower-workbench-backup-pg-${suffix}`;
  const sourceProjectId = `backup-source-${process.pid}`;
  const targetProjectId = `backup-target-${process.pid}`;
  const root = path.join(os.tmpdir(), `tower-workbench-backup-e2e-${suffix}`);
  const workspaceRoot = path.join(root, 'workspace');
  const storeRoot = path.join(root, 'store');
  const restoreStoreRoot = path.join(root, 'restore-store');
  const backupPath = path.join(root, 'backup');
  let modules: any;

  beforeAll(async () => {
    await fs.mkdir(path.join(workspaceRoot, 'projects', sourceProjectId), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, 'projects', targetProjectId), { recursive: true });
    await docker('run', '-d', '--rm', '--name', pgName, '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=tower_test', '-p', '127.0.0.1::5432', 'postgres:16-alpine');
    const mapped = await docker('port', pgName, '5432/tcp');
    const port = Number(mapped.stdout.trim().match(/:(\d+)$/)?.[1]);
    const databaseUrl = `postgresql://postgres:test@127.0.0.1:${port}/tower_test`;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { await runFile('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1']); break; }
      catch { if (attempt === 39) throw new Error('Disposable PostgreSQL did not become ready'); await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    process.env.DATABASE_URL = databaseUrl;
    process.env.WORKSPACE_ROOT = workspaceRoot;
    process.env.TOWER_WORKBENCH_TOOL_STORE_ROOT = storeRoot;
    modules = {
      backup: await import('./workbench-tool-backup.js'), tools: await import('./workbench-tools.js'),
      db: await import('../../db/pg-repo.js'), pg: await import('../../db/pg.js'),
    };
    const migrations = path.resolve(process.cwd(), 'packages/backend/db/migrations');
    for (const file of ['007_users.sql', '008_sessions.sql', '009_projects.sql', '075_project_runtime_boxes.sql', '077_project_runtime_box_node22_profile.sql', '150_runtime_box_workbench_tool_revisions.sql', '152_runtime_box_workbench_tool_store_refs.sql']) {
      await runFile('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', path.join(migrations, file)]);
    }
    await modules.db.queryOne(`INSERT INTO users(id,username,password_hash,role) VALUES(7,'operator','x','operator') RETURNING id`);
    for (const id of [sourceProjectId, targetProjectId]) {
      await modules.db.queryOne(`INSERT INTO projects(id,name,root_path,user_id) VALUES($1,$1,$2,7) RETURNING id`, [id, path.join(workspaceRoot, 'projects', id)]);
    }
    const manifest = {
      schemaVersion: 1, workbenchId: sourceProjectId, revision: 4, createdAt: '2026-08-04T00:00:00.000Z',
      createdBy: { userId: 7, sessionId: null, jobId: null }, manager: 'uv-tool',
      tools: [{ name: 'workbench-probe', version: '1.0.0', entrypoints: ['workbench-probe'], installSpec: 'workbench-probe==1.0.0' }],
      paths: { prefix: '.runtime-box/workbench-tools/revisions/000004', bin: '.runtime-box/workbench-tools/revisions/000004/bin' },
      validation: { status: 'passed', commands: [{ cmd: 'workbench-probe --version', exitCode: 0 }] }, previousRevision: 3, rollbackRef: null,
    };
    const hash = modules.tools.stableManifestHash(manifest);
    const revisionPath = path.join(storeRoot, 'projects', sourceProjectId, 'revisions', '000004');
    await fs.mkdir(path.join(revisionPath, 'bin'), { recursive: true });
    await fs.writeFile(path.join(revisionPath, 'bin', 'workbench-probe'), '#!/bin/sh\necho restored-probe-1.0.0\n', { mode: 0o755 });
    await fs.writeFile(path.join(revisionPath, 'manifest.json'), modules.tools.stableManifestJson(manifest));
    await modules.db.queryOne(`INSERT INTO runtime_box_workbench_tool_revisions
      (project_id,revision,state,previous_revision,manager,manifest,manifest_hash,prefix_relpath,validation,reason,requested_by_user_id,storage_kind,store_ref,store_manifest_hash,activated_at)
      VALUES($1,4,'active',NULL,'uv-tool',$2::jsonb,$3,$4,$5::jsonb,'e2e',7,'tower-managed-v1',$6,$3,NOW()) RETURNING revision`,
    [sourceProjectId, JSON.stringify(manifest), hash, manifest.paths.prefix, JSON.stringify(manifest.validation), `projects/${sourceProjectId}/revisions/000004`]);
    await modules.db.queryOne(`INSERT INTO runtime_box_workbench_tool_states(project_id,current_revision,health,storage_mode,updated_by_user_id)
      VALUES($1,4,'healthy','tower-managed-v1',7) RETURNING project_id`, [sourceProjectId]);
  }, 120_000);

  afterAll(async () => {
    await modules?.pg?.closePgPool?.().catch(() => undefined);
    await docker('rm', '-f', '-v', pgName).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
    for (const key of ['DATABASE_URL', 'WORKSPACE_ROOT', 'TOWER_WORKBENCH_TOOL_STORE_ROOT']) delete process.env[key];
  }, 120_000);

  it('restores active metadata and payload for a new Project and executes the restored CLI', async () => {
    const metadata = await modules.backup.createWorkbenchActiveRevisionBackup({ projectId: sourceProjectId, backupPath, storeRoot });
    expect(metadata.excludes).toEqual(['credentials', 'project-files', 'cache', 'command-history', 'inactive-revisions']);
    const restored = await modules.backup.restoreWorkbenchActiveRevisionBackup({ backupPath, targetProjectId, targetStoreRoot: restoreStoreRoot });
    await modules.db.queryOne(`INSERT INTO runtime_box_workbench_tool_revisions
      (project_id,revision,state,manager,manifest,manifest_hash,prefix_relpath,validation,reason,requested_by_user_id,storage_kind,store_ref,store_manifest_hash,activated_at)
      VALUES($1,1,'active','uv-tool',$2::jsonb,$3,$4,$5::jsonb,$6,7,'tower-managed-v1',$7,$3,NOW()) RETURNING revision`,
    [targetProjectId, JSON.stringify(restored.revisionRow.manifest), restored.revisionRow.manifestHash, restored.revisionRow.prefixRelpath, JSON.stringify(restored.revisionRow.validation), restored.revisionRow.reason, restored.revisionRow.storeRef]);
    await modules.db.queryOne(`INSERT INTO runtime_box_workbench_tool_states(project_id,current_revision,health,storage_mode,updated_by_user_id)
      VALUES($1,1,'healthy','tower-managed-v1',7) RETURNING project_id`, [targetProjectId]);
    expect(await modules.db.queryOne(`SELECT current_revision,health,storage_mode FROM runtime_box_workbench_tool_states WHERE project_id=$1`, [targetProjectId]))
      .toMatchObject({ current_revision: 1, health: 'healthy', storage_mode: 'tower-managed-v1' });
    const executed = await runFile(path.join(restored.revisionPath, 'bin', 'workbench-probe'), []);
    expect(executed.stdout.trim()).toBe('restored-probe-1.0.0');
  }, 30_000);
});
