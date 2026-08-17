import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runFile = promisify(execFile);
const run = process.env.RUNTIME_BOX_STALE_TRANSITION_E2E === '1' ? describe : describe.skip;

async function docker(...args: string[]) {
  return runFile('docker', args, { maxBuffer: 2_000_000 });
}

run('confirmed-stale reconcile atomic transition', () => {
  const suffix = randomBytes(5).toString('hex');
  const pgName = `tower-l3c-gate-pg-${suffix}`;
  const projectId = `l3c-gate-${suffix}`;
  const containerName = `tower-box-l3c-${suffix}`;
  const userId = 91;
  let databaseUrl = '';
  let boxId = 0;
  let modules: any;
  let previousDatabaseUrl: string | undefined;

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    await docker('run', '-d', '--rm', '--name', pgName,
      '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=tower_test',
      '-p', '127.0.0.1::5432', 'postgres:16-alpine');
    const mapped = await docker('port', pgName, '5432/tcp');
    const port = Number(mapped.stdout.trim().match(/:(\d+)$/)?.[1]);
    databaseUrl = `postgresql://postgres:test@127.0.0.1:${port}/tower_test`;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await runFile('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1']);
        break;
      } catch {
        if (attempt === 39) throw new Error('Disposable PostgreSQL did not become ready');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    process.env.DATABASE_URL = databaseUrl;

    const migrationRoot = path.resolve(process.cwd(), 'packages/backend/db/migrations');
    for (const file of [
      '007_users.sql', '008_sessions.sql', '009_projects.sql',
      '075_project_runtime_boxes.sql', '077_project_runtime_box_node22_profile.sql',
      '078_runtime_box_service_supervision.sql', '079_runtime_box_preview_proxy.sql',
      '094_runtime_box_operator_tools_profile.sql',
      '150_runtime_box_workbench_tool_revisions.sql',
      '152_runtime_box_workbench_tool_store_refs.sql',
    ]) {
      await runFile('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', path.join(migrationRoot, file)]);
    }
    modules = {
      db: await import('../../db/pg-repo.js'),
      manager: await import('./runtime-box-manager.js'),
      closePg: (await import('../../db/pg.js')).closePgPool,
    };
    await modules.db.execute(
      `INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,'x','operator')`,
      [userId, `l3c-gate-${suffix}`],
    );
    await modules.db.execute(
      `INSERT INTO projects(id,name,root_path,user_id) VALUES($1,'L3c Gate','/tmp/l3c-gate',$2)`,
      [projectId, userId],
    );
    const box = await modules.db.queryOne<{ id: number }>(
      `INSERT INTO project_runtime_boxes
         (project_id,status,runtime_profile,project_root,memory_mb,cpu_limit,pids_limit,disk_quota_mb,idle_stop_minutes,created_by)
       VALUES($1,'running','node22-python313','/tmp/l3c-gate',1024,1,256,1024,20,$2)
       RETURNING id`,
      [projectId, userId],
    );
    boxId = Number(box?.id);
    await docker('create', '--name', containerName,
      '--label', `tower.box.id=${boxId}`,
      '--label', `tower.project.id=${projectId}`,
      'alpine:3.20', 'true');
    const inspected = await docker('inspect', '-f', '{{.Id}}', containerName);
    await modules.db.execute('UPDATE project_runtime_boxes SET container_id=$2 WHERE id=$1', [boxId, inspected.stdout.trim()]);
    await modules.db.execute(
      `INSERT INTO runtime_box_services
         (box_id,project_id,name,command,internal_port,status,process_pid,created_by)
       VALUES($1,$2,'probe','sleep 999',4100,'running',43210,$3)`,
      [boxId, projectId, userId],
    );
    await modules.db.execute(
      `INSERT INTO runtime_box_workbench_tool_states(project_id,current_revision,health,storage_mode,updated_by_user_id)
       VALUES($1,NULL,'healthy','tower-managed-v1',$2)`,
      [projectId, userId],
    );
    await modules.db.execute(
      `INSERT INTO runtime_box_workbench_tool_revisions
         (project_id,revision,state,manager,manifest,manifest_hash,prefix_relpath,validation,requested_by_user_id,storage_kind,store_ref,store_manifest_hash)
       VALUES($1,1,'active','uv-tool','{}'::jsonb,
         'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
         '.runtime-box/workbench-tools/revisions/000001','{}'::jsonb,$2,'tower-managed-v1',
         'projects/fixture/revisions/000001','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`,
      [projectId, userId],
    );
    await modules.db.execute(
      `INSERT INTO runtime_box_workbench_tool_projections
         (box_id,project_id,revision,manifest_hash,store_ref,status)
       VALUES($1,$2,1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','projects/fixture/revisions/000001','mounted')`,
      [boxId, projectId],
    );
  }, 120_000);

  afterAll(async () => {
    await modules?.closePg?.().catch(() => undefined);
    await docker('rm', '-f', containerName).catch(() => undefined);
    await docker('rm', '-f', pgName).catch(() => undefined);
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it('defers confirmed-stale transition while the Box activity lock is held', async () => {
    const activityClient = await (await import('../../db/pg.js')).getPgPool().connect();
    try {
      await activityClient.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`runtime-box-activity:${boxId}`]);
      expect(await modules.manager.reconcileRuntimeBoxes()).toBe(0);
      const box = await modules.db.queryOne<any>('SELECT status,container_id FROM project_runtime_boxes WHERE id=$1', [boxId]);
      const service = await modules.db.queryOne<any>('SELECT status,process_pid FROM runtime_box_services WHERE box_id=$1', [boxId]);
      const projection = await modules.db.queryOne<any>('SELECT status FROM runtime_box_workbench_tool_projections WHERE box_id=$1', [boxId]);
      expect(box).toMatchObject({ status: 'running' });
      expect(typeof box.container_id).toBe('string');
      expect(service).toEqual({ status: 'running', process_pid: 43210 });
      expect(projection).toEqual({ status: 'mounted' });
    } finally {
      await activityClient.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`runtime-box-activity:${boxId}`]).catch(() => undefined);
      activityClient.release();
    }
  }, 120_000);

  it('rolls back Box, Service, and Projection together after injected Service failure', async () => {
    await modules.db.execute(`CREATE OR REPLACE FUNCTION reject_l3c_service_transition()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected Service transition failure'; END $$`);
    await modules.db.execute(`CREATE TRIGGER reject_l3c_service_transition
      BEFORE UPDATE ON runtime_box_services FOR EACH ROW EXECUTE FUNCTION reject_l3c_service_transition()`);

    await expect(modules.manager.reconcileRuntimeBoxes()).rejects.toThrow(/injected Service transition failure/);

    const box = await modules.db.queryOne<any>('SELECT status,container_id FROM project_runtime_boxes WHERE id=$1', [boxId]);
    const service = await modules.db.queryOne<any>('SELECT status,process_pid FROM runtime_box_services WHERE box_id=$1', [boxId]);
    const projection = await modules.db.queryOne<any>('SELECT status FROM runtime_box_workbench_tool_projections WHERE box_id=$1', [boxId]);

    expect(box).toMatchObject({ status: 'running' });
    expect(typeof box.container_id).toBe('string');
    expect(service).toEqual({ status: 'running', process_pid: 43210 });
    expect(projection).toEqual({ status: 'mounted' });
  }, 120_000);
});
