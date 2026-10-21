import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runFile = promisify(execFile);
const enabled = process.env.WORKBENCH_PROJECTION_E2E === '1';
const run = enabled ? describe : describe.skip;

async function docker(...args: string[]) {
  return runFile('docker', args, { maxBuffer: 2_000_000 });
}

run('Workbench managed store read-only projection disposable PostgreSQL + Docker E2E', () => {
  const pgName = `tower-workbench-projection-pg-${process.pid}`;
  const projectId = `workbench-projection-${process.pid}`;
  const userId = 77;
  let root = '';
  let workspaceRoot = '';
  let projectRoot = '';
  let storeRoot = '';
  let pgPort = 0;
  let boxId = 0;
  let manifestHash = '';
  let manifestJson = '';
  let revisionPath = '';
  let modules: any;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-workbench-projection-e2e-'));
    workspaceRoot = path.join(root, 'workspace');
    projectRoot = path.join(workspaceRoot, 'projects', projectId);
    storeRoot = path.join(root, 'tower-data', 'runtime-box', 'workbench-tools');
    await fs.mkdir(projectRoot, { recursive: true });
    pgPort = 28000 + (process.pid % 1000);
    await docker('run', '-d', '--rm', '--name', pgName, '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=tower_test', '-p', `127.0.0.1:${pgPort}:5432`, 'postgres:16-alpine');
    for (let i = 0; i < 40; i += 1) {
      try {
        await docker('exec', pgName, 'pg_isready', '-U', 'postgres', '-d', 'tower_test');
        await runFile('psql', [`postgresql://postgres:test@127.0.0.1:${pgPort}/tower_test`, '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1']);
        break;
      } catch {
        if (i === 39) throw new Error('Disposable PostgreSQL did not become ready');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    process.env.DATABASE_URL = `postgresql://postgres:test@127.0.0.1:${pgPort}/tower_test`;
    process.env.WORKSPACE_ROOT = workspaceRoot;
    process.env.TOWER_DATA_DIR = path.join(root, 'tower-data');
    process.env.TOWER_WORKBENCH_TOOL_STORE_ROOT = storeRoot;
    process.env.TOWER_EXPERIMENTAL_WORKBENCH_TOOLS_ENABLED = 'true';
    process.env.TOWER_EXPERIMENTAL_WORKBENCH_TOOL_PROJECT_IDS = JSON.stringify([projectId]);
    process.env.RUNTIME_BOX_IMAGE = 'tower-runtime-box:node22-python313';
    process.env.RUNTIME_BOX_MAX_RUNNING = '4';
    process.env.RUNTIME_BOX_MAX_RUNNING_PER_USER = '4';

    const migrationRoot = path.resolve(process.cwd(), 'packages/backend/db/migrations');
    for (const file of [
      '007_users.sql', '008_sessions.sql', '009_projects.sql',
      '075_project_runtime_boxes.sql', '077_project_runtime_box_node22_profile.sql',
      '078_runtime_box_service_supervision.sql', '079_runtime_box_preview_proxy.sql',
      '094_runtime_box_operator_tools_profile.sql',
      '150_runtime_box_workbench_tool_revisions.sql',
      '152_runtime_box_workbench_tool_store_refs.sql',
    ]) {
      await runFile('psql', [process.env.DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-f', path.join(migrationRoot, file)]);
    }
    await runFile('psql', [process.env.DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-c',
      `INSERT INTO users(id,username,password_hash,role) VALUES(${userId},'projection-e2e','x','operator');
       INSERT INTO projects(id,name,root_path,user_id) VALUES('${projectId}','Projection E2E','${projectRoot.replaceAll("'", "''")}',${userId});`]);

    const tools = await import('./workbench-tools.js');
    const store = await import('./workbench-tool-store.js');
    const manifest = {
      schemaVersion: 1 as const,
      workbenchId: projectId,
      revision: 1,
      createdAt: '2026-07-31T00:00:00.000Z',
      createdBy: { userId, sessionId: null, jobId: null },
      manager: 'uv-tool' as const,
      tools: [{ name: 'workbench-probe', version: '1.0.0', entrypoints: ['workbench-probe'], installSpec: 'workbench-probe==1.0.0' }],
      paths: { prefix: '.runtime-box/workbench-tools/revisions/000001', bin: '.runtime-box/workbench-tools/revisions/000001/bin' },
      validation: { status: 'passed' as const, commands: [{ cmd: 'workbench-probe', exitCode: 0 as const }] },
      previousRevision: null,
      rollbackRef: null,
    };
    manifestHash = tools.stableManifestHash(manifest);
    manifestJson = tools.stableManifestJson(manifest);
    const storeRef = store.managedWorkbenchToolStoreRef(projectId, 1);
    revisionPath = path.join(storeRoot, storeRef);
    await fs.mkdir(path.join(revisionPath, 'bin'), { recursive: true });
    await fs.writeFile(path.join(revisionPath, 'bin', 'workbench-probe'), `#!/bin/sh\necho revision=1 manifest=${manifestHash}\n`, { mode: 0o755 });
    await fs.writeFile(path.join(revisionPath, 'payload.txt'), 'immutable-payload\n');
    await fs.writeFile(path.join(revisionPath, 'manifest.json'), manifestJson);
    await fs.mkdir(path.join(storeRoot, 'projects', projectId, 'revisions', '000000'), { recursive: true });
    await fs.mkdir(path.join(storeRoot, 'projects', projectId, 'staging', 'command-1'), { recursive: true });

    await runFile('psql', [process.env.DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-c',
      `INSERT INTO runtime_box_workbench_tool_states(project_id,current_revision,health,storage_mode,updated_by_user_id)
       VALUES('${projectId}',NULL,'healthy','tower-managed-v1',${userId});
       INSERT INTO runtime_box_workbench_tool_revisions
         (project_id,revision,state,manager,manifest,manifest_hash,prefix_relpath,validation,requested_by_user_id,activated_at,storage_kind,store_ref,store_manifest_hash)
       VALUES('${projectId}',1,'active','uv-tool','${JSON.stringify(manifest).replaceAll("'", "''")}'::jsonb,'${manifestHash}',
         '.runtime-box/workbench-tools/revisions/000001','{}'::jsonb,${userId},NOW(),'tower-managed-v1','${storeRef}','${manifestHash}');
       UPDATE runtime_box_workbench_tool_states SET current_revision=1 WHERE project_id='${projectId}';
       INSERT INTO project_runtime_boxes(project_id,status,runtime_profile,project_root,memory_mb,cpu_limit,pids_limit,disk_quota_mb,idle_stop_minutes,created_by)
       VALUES('${projectId}','stopped','node22-python313','${projectRoot.replaceAll("'", "''")}',1024,1,256,1024,20,${userId}) RETURNING id;`]);

    const db = await import('../../db/pg-repo.js');
    const box = await db.queryOne<{ id: number }>('SELECT id FROM project_runtime_boxes WHERE project_id=$1', [projectId]);
    boxId = Number(box?.id);
    modules = {
      db,
      manager: await import('./runtime-box-manager.js'),
      service: await import('./service-registry.js'),
      closePg: (await import('../../db/pg.js')).closePgPool,
    };
  }, 120_000);

  afterAll(async () => {
    if (modules && boxId) await modules.manager.stopBox(boxId).catch(() => undefined);
    await modules?.closePg?.().catch(() => undefined);
    await docker('rm', '-f', `tower-box-${boxId}`).catch(() => undefined);
    await docker('rm', '-f', '-v', pgName).catch(() => undefined);
    if (root) {
      await docker('run', '--rm', '-v', `${root}:/cleanup`, 'alpine:3.20', 'sh', '-c', 'chmod -R 777 /cleanup').catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
    for (const key of [
      'DATABASE_URL', 'WORKSPACE_ROOT', 'TOWER_DATA_DIR', 'TOWER_WORKBENCH_TOOL_STORE_ROOT',
      'TOWER_EXPERIMENTAL_WORKBENCH_TOOLS_ENABLED', 'TOWER_EXPERIMENTAL_WORKBENCH_TOOL_PROJECT_IDS',
      'RUNTIME_BOX_IMAGE', 'RUNTIME_BOX_MAX_RUNNING', 'RUNTIME_BOX_MAX_RUNNING_PER_USER',
    ]) delete process.env[key];
  }, 120_000);

  it('enforces the active revision as a real read-only child mount and preserves Project writes', async () => {
    await modules.manager.ensureRunning(boxId, userId);
    const inspectBefore = await docker('inspect', `tower-box-${boxId}`, '--format', '{{json .Mounts}}');
    const projectionBefore = await modules.db.queryOne<any>('SELECT * FROM runtime_box_workbench_tool_projections WHERE box_id=$1', [boxId]);
    const exec = (cmd: string) => modules.manager.execInBox({ boxId, userId, cmd, credentialMode: 'none' });
    const cli = await exec('printf "PATH=%s\\n" "$PATH"; ls -la .runtime-box/workbench-tools/active/bin; workbench-probe');
    expect(cli.exit_code, JSON.stringify({ cli, inspect: inspectBefore.stdout, projectionBefore })).toBe(0);
    expect(cli.stdout).toContain(`revision=1 manifest=${manifestHash}`);

    expect((await exec("printf changed > project-source.txt && cat project-source.txt")).stdout).toContain('changed');
    for (const cmd of [
      'touch .runtime-box/workbench-tools/active/new-file',
      "printf changed > .runtime-box/workbench-tools/active/payload.txt",
      'rm .runtime-box/workbench-tools/active/payload.txt',
    ]) {
      const result = await exec(cmd);
      expect(result.exit_code).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/Read-only file system|read-only/i);
    }
    expect((await exec('test ! -e .runtime-box/workbench-tools/revisions && echo revisions-hidden')).stdout).toContain('revisions-hidden');
    expect((await exec('test ! -e .runtime-box/workbench-tools/staging && echo staging-hidden')).stdout).toContain('staging-hidden');
    expect((await exec('test ! -e .runtime-box/workbench-tools/active/../revisions && echo store-hidden')).stdout).toContain('store-hidden');

    const service = await modules.service.registerService({
      boxId, projectId, name: 'projection-probe', command: 'workbench-probe; sleep 30', cwd: '/workspace',
      port: 19091, ttlHours: 1, createdBy: userId,
    });
    await modules.service.startServiceProcess(service.id);
    await new Promise(resolve => setTimeout(resolve, 300));
    const log = await modules.service.readServiceLogs(service.id, 30);
    expect(log).toContain(`revision=1 manifest=${manifestHash}`);

    const mounted = await modules.db.queryOne<any>('SELECT * FROM runtime_box_workbench_tool_projections WHERE box_id=$1', [boxId]);
    expect(mounted).toMatchObject({ revision: 1, manifest_hash: manifestHash, status: 'mounted' });
    expect(mounted.store_ref).toBe(`projects/${projectId}/revisions/000001`);
    expect(JSON.stringify(mounted)).not.toContain(storeRoot);

    await modules.manager.stopBox(boxId);
    expect((await modules.db.queryOne<any>('SELECT status FROM runtime_box_workbench_tool_projections WHERE box_id=$1', [boxId]))?.status).toBe('unmounted');
    await modules.manager.stopBox(boxId);
    expect((await modules.db.queryOne<any>('SELECT status FROM runtime_box_workbench_tool_projections WHERE box_id=$1', [boxId]))?.status).toBe('unmounted');

    await modules.manager.ensureRunning(boxId, userId);
    expect((await exec('workbench-probe')).stdout).toContain(`revision=1 manifest=${manifestHash}`);
    expect(await docker('inspect', `tower-box-${boxId}`, '--format', '{{range .Mounts}}{{if eq .Destination "/workspace/.runtime-box/workbench-tools/active"}}{{.RW}} {{.Source}}{{end}}{{end}}'))
      .toMatchObject({ stdout: expect.stringContaining('false ') });
    const recreated = await modules.db.queryOne<any>('SELECT revision,manifest_hash,status FROM runtime_box_workbench_tool_projections WHERE box_id=$1', [boxId]);
    expect(recreated).toMatchObject({ revision: 1, manifest_hash: manifestHash, status: 'mounted' });
  }, 120_000);

  it('fails closed for divergent DB/store state without leaving a container or mounted observation', async () => {
    await modules.manager.stopBox(boxId);
    const storeRef = `projects/${projectId}/revisions/000001`;
    const cases: Array<{ name: string; breakState: () => Promise<void>; restore: () => Promise<void> }> = [
      {
        name: 'DB current revision row missing',
        breakState: async () => {
          await modules.db.execute('ALTER TABLE runtime_box_workbench_tool_states DROP CONSTRAINT runtime_box_workbench_tool_current_revision_fkey');
          await modules.db.execute('UPDATE runtime_box_workbench_tool_states SET current_revision=999 WHERE project_id=$1', [projectId]);
        },
        restore: async () => {
          await modules.db.execute('UPDATE runtime_box_workbench_tool_states SET current_revision=1 WHERE project_id=$1', [projectId]);
          await modules.db.execute(`ALTER TABLE runtime_box_workbench_tool_states ADD CONSTRAINT runtime_box_workbench_tool_current_revision_fkey FOREIGN KEY(project_id,current_revision) REFERENCES runtime_box_workbench_tool_revisions(project_id,revision) ON DELETE RESTRICT`);
        },
      },
      {
        name: 'store_ref other Project identity',
        breakState: () => modules.db.execute("UPDATE runtime_box_workbench_tool_revisions SET store_ref='projects/other/revisions/000001' WHERE project_id=$1 AND revision=1", [projectId]),
        restore: () => modules.db.execute('UPDATE runtime_box_workbench_tool_revisions SET store_ref=$2 WHERE project_id=$1 AND revision=1', [projectId, storeRef]),
      },
      {
        name: 'revision directory symlink',
        breakState: async () => { await fs.rename(revisionPath, `${revisionPath}.real`); await fs.symlink(`${revisionPath}.real`, revisionPath, 'dir'); },
        restore: async () => { await fs.rm(revisionPath); await fs.rename(`${revisionPath}.real`, revisionPath); },
      },
      {
        name: 'DB/store manifest hash mismatch',
        breakState: () => modules.db.execute("UPDATE runtime_box_workbench_tool_revisions SET store_manifest_hash=$2 WHERE project_id=$1 AND revision=1", [projectId, 'f'.repeat(64)]),
        restore: () => modules.db.execute('UPDATE runtime_box_workbench_tool_revisions SET store_manifest_hash=$2 WHERE project_id=$1 AND revision=1', [projectId, manifestHash]),
      },
      {
        name: 'store manifest content hash mismatch',
        breakState: async () => { await fs.writeFile(path.join(revisionPath, 'manifest.json'), manifestJson.replace('"version": "1.0.0"', '"version": "9.9.9"')); },
        restore: async () => { await fs.writeFile(path.join(revisionPath, 'manifest.json'), manifestJson); },
      },
      {
        name: 'manifest Project identity mismatch',
        breakState: async () => { await fs.writeFile(path.join(revisionPath, 'manifest.json'), manifestJson.replace(projectId, 'other-project')); },
        restore: async () => { await fs.writeFile(path.join(revisionPath, 'manifest.json'), manifestJson); },
      },
      {
        name: 'entrypoint missing',
        breakState: async () => { await fs.rename(path.join(revisionPath, 'bin', 'workbench-probe'), path.join(revisionPath, 'bin', 'workbench-probe.saved')); },
        restore: async () => { await fs.rename(path.join(revisionPath, 'bin', 'workbench-probe.saved'), path.join(revisionPath, 'bin', 'workbench-probe')); },
      },
      {
        name: 'read-only child mount source rejected by Docker',
        breakState: async () => { await fs.chmod(revisionPath, 0o000); },
        restore: async () => { await fs.chmod(revisionPath, 0o755); },
      },
    ];

    for (const failure of cases) {
      await modules.db.execute("UPDATE project_runtime_boxes SET status='stopped',container_id=NULL,last_error=NULL WHERE id=$1", [boxId]);
      await modules.db.execute('DELETE FROM runtime_box_workbench_tool_projections WHERE box_id=$1', [boxId]);
      await failure.breakState();
      await expect(modules.manager.ensureRunning(boxId, userId), failure.name).rejects.toThrow();
      await expect(docker('inspect', `tower-box-${boxId}`), failure.name).rejects.toBeTruthy();
      expect(await modules.db.queryOne('SELECT 1 FROM runtime_box_workbench_tool_projections WHERE box_id=$1', [boxId]), failure.name).toBeUndefined();
      await failure.restore();
    }
  }, 120_000);

  it('removes a created container if forensic projection observation cannot be recorded', async () => {
    await modules.db.execute("UPDATE project_runtime_boxes SET status='stopped',container_id=NULL,last_error=NULL WHERE id=$1", [boxId]);
    await modules.db.execute('DELETE FROM runtime_box_workbench_tool_projections WHERE box_id=$1', [boxId]);
    await modules.db.execute(`CREATE OR REPLACE FUNCTION reject_projection_observation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'projection observation rejected'; END $$`);
    await modules.db.execute('CREATE TRIGGER reject_projection_observation BEFORE INSERT ON runtime_box_workbench_tool_projections FOR EACH ROW EXECUTE FUNCTION reject_projection_observation()');
    await expect(modules.manager.ensureRunning(boxId, userId)).rejects.toThrow(/projection observation rejected/);
    await expect(docker('inspect', `tower-box-${boxId}`)).rejects.toBeTruthy();
    const box = await modules.db.queryOne<any>('SELECT status,container_id FROM project_runtime_boxes WHERE id=$1', [boxId]);
    expect(box).toMatchObject({ status: 'error', container_id: null });
    expect(await modules.db.queryOne('SELECT 1 FROM runtime_box_workbench_tool_projections WHERE box_id=$1', [boxId])).toBeUndefined();
    await modules.db.execute('DROP TRIGGER reject_projection_observation ON runtime_box_workbench_tool_projections');
    await modules.db.execute('DROP FUNCTION reject_projection_observation()');
  }, 120_000);

  it('compensates a mounted projection when the Runtime running-row finalize update fails', async () => {
    await modules.db.execute("UPDATE project_runtime_boxes SET status='stopped',container_id=NULL,last_error=NULL WHERE id=$1", [boxId]);
    await modules.db.execute('DELETE FROM runtime_box_workbench_tool_projections WHERE box_id=$1', [boxId]);
    await modules.db.execute(`CREATE OR REPLACE FUNCTION reject_runtime_running_finalize() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'running' THEN RAISE EXCEPTION 'runtime running finalize rejected'; END IF; RETURN NEW; END $$`);
    await modules.db.execute('CREATE TRIGGER reject_runtime_running_finalize BEFORE UPDATE ON project_runtime_boxes FOR EACH ROW EXECUTE FUNCTION reject_runtime_running_finalize()');

    await expect(modules.manager.ensureRunning(boxId, userId)).rejects.toThrow(/runtime running finalize rejected/);
    await expect(docker('inspect', `tower-box-${boxId}`)).rejects.toBeTruthy();
    const box = await modules.db.queryOne<any>('SELECT status,container_id FROM project_runtime_boxes WHERE id=$1', [boxId]);
    expect(box).toMatchObject({ status: 'error', container_id: null });
    const projection = await modules.db.queryOne<any>('SELECT status FROM runtime_box_workbench_tool_projections WHERE box_id=$1', [boxId]);
    expect(projection).toMatchObject({ status: 'recovery_required' });

    await modules.db.execute('DROP TRIGGER reject_runtime_running_finalize ON project_runtime_boxes');
    await modules.db.execute('DROP FUNCTION reject_runtime_running_finalize()');
  }, 120_000);

  it('keeps feature-off, uninitialized, and legacy project-prefix Projects on the existing Runtime path', async () => {
    process.env.TOWER_EXPERIMENTAL_WORKBENCH_TOOLS_ENABLED = 'false';
    await modules.db.execute("UPDATE project_runtime_boxes SET status='stopped',container_id=NULL,last_error=NULL WHERE id=$1", [boxId]);
    await modules.manager.ensureRunning(boxId, userId);
    const mounts = JSON.parse((await docker('inspect', `tower-box-${boxId}`, '--format', '{{json .Mounts}}')).stdout);
    expect(mounts.map((mount: any) => mount.Destination)).toEqual(['/workspace']);
    expect(await modules.db.queryOne('SELECT 1 FROM runtime_box_workbench_tool_projections WHERE box_id=$1 AND status=\'mounted\'', [boxId])).toBeUndefined();
    await modules.manager.stopBox(boxId);

    process.env.TOWER_EXPERIMENTAL_WORKBENCH_TOOLS_ENABLED = 'true';
    await modules.db.execute('UPDATE runtime_box_workbench_tool_states SET current_revision=NULL WHERE project_id=$1', [projectId]);
    await modules.manager.ensureRunning(boxId, userId);
    expect(JSON.parse((await docker('inspect', `tower-box-${boxId}`, '--format', '{{json .Mounts}}')).stdout).map((mount: any) => mount.Destination)).toEqual(['/workspace']);
    await modules.manager.stopBox(boxId);

    await modules.db.execute("UPDATE runtime_box_workbench_tool_states SET current_revision=1,storage_mode='project-prefix' WHERE project_id=$1", [projectId]);
    await modules.db.execute("UPDATE runtime_box_workbench_tool_revisions SET storage_kind='project-prefix' WHERE project_id=$1 AND revision=1", [projectId]);
    await expect(modules.manager.ensureRunning(boxId, userId)).rejects.toThrow(/not stored in the Tower-managed store/);
    await expect(docker('inspect', `tower-box-${boxId}`)).rejects.toBeTruthy();
    await modules.db.execute("UPDATE runtime_box_workbench_tool_states SET storage_mode='tower-managed-v1' WHERE project_id=$1", [projectId]);
    await modules.db.execute("UPDATE runtime_box_workbench_tool_revisions SET storage_kind='tower-managed-v1' WHERE project_id=$1 AND revision=1", [projectId]);
  }, 120_000);
});
