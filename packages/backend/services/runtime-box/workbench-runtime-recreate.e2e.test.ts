import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runFile = promisify(execFile);
const run = process.env.WORKBENCH_RUNTIME_RECREATE_E2E === '1' ? describe : describe.skip;
async function docker(...args: string[]) { return runFile('docker', args, { maxBuffer: 4_000_000 }); }
async function psql(url: string, sql: string) { return runFile('psql', [url, '-v', 'ON_ERROR_STOP=1', '-c', sql], { maxBuffer: 4_000_000 }); }

run('Workbench Runtime recreate disposable Docker + PostgreSQL E2E', () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const pgName = `tower-workbench-recreate-pg-${suffix}`;
  const projectId = `project-recreate-${process.pid}`;
  const sessionId = `session-recreate-${process.pid}`;
  const actor = { userId: 7, role: 'operator', sessionId };
  const workspaceRoot = path.join(os.tmpdir(), `tower-a4b-workspace-${suffix}`);
  const projectRoot = path.join(workspaceRoot, 'projects', projectId);
  const storeRoot = path.join(os.tmpdir(), `tower-a4b-store-${suffix}`);
  let databaseUrl = '';
  let boxId = 0;
  let modules: any;

  async function createRevision(revision: number, entrypoint: string) {
    const revisionName = String(revision).padStart(6, '0');
    const revisionPath = path.join(storeRoot, 'projects', projectId, 'revisions', revisionName);
    await fs.mkdir(path.join(revisionPath, 'bin'), { recursive: true });
    await fs.writeFile(path.join(revisionPath, 'bin', entrypoint), `#!/bin/sh\necho ${entrypoint}-${revision}\n`, { mode: 0o755 });
    const manifest = {
      schemaVersion: 1, workbenchId: projectId, revision, createdAt: new Date().toISOString(),
      createdBy: { userId: 7, sessionId, jobId: null }, manager: 'uv-tool',
      tools: [{ name: entrypoint, version: String(revision), entrypoints: [entrypoint], installSpec: `${entrypoint}==${revision}` }],
      paths: { prefix: `.runtime-box/workbench-tools/revisions/${revisionName}`, bin: `.runtime-box/workbench-tools/revisions/${revisionName}/bin` },
      validation: { status: 'passed', commands: [{ cmd: `${entrypoint} --version`, exitCode: 0 }] },
      previousRevision: revision === 1 ? null : revision - 1, rollbackRef: revision === 1 ? null : `revisions/${String(revision - 1).padStart(6, '0')}`,
    };
    const hash = modules.tools.stableManifestHash(manifest);
    await fs.writeFile(path.join(revisionPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const manifestState = revision === 1 || revision >= 3 ? 'superseded' : 'active';
    await psql(databaseUrl, `INSERT INTO runtime_box_workbench_tool_revisions
      (project_id,revision,state,previous_revision,manager,manifest,manifest_hash,prefix_relpath,validation,reason,requested_by_user_id,storage_kind,store_ref,store_manifest_hash,activated_at)
      VALUES('${projectId}',${revision},'${manifestState}',${revision === 1 ? 'NULL' : revision - 1},'uv-tool','${JSON.stringify(manifest).replaceAll("'", "''")}'::jsonb,'${hash}','${manifest.paths.prefix}','${JSON.stringify(manifest.validation).replaceAll("'", "''")}'::jsonb,'e2e',7,'tower-managed-v1','projects/${projectId}/revisions/${revisionName}','${hash}',NOW());`);
    return { revisionPath, manifest, hash };
  }

  async function startOldContainer(revisionPath: string) {
    const name = `tower-box-${boxId}`;
    const result = await docker('run', '-d', '--name', name,
      '--mount', `type=bind,src=${projectRoot},dst=/workspace,readonly=false`,
      '--mount', `type=bind,src=${revisionPath},dst=/workspace/.runtime-box/workbench-tools/active,readonly=true`,
      '--label', `tower.box.id=${boxId}`,
      '--label', `tower.project.id=${projectId}`,
      'tower-runtime-box:node22-python313', 'sleep', 'infinity');
    const id = result.stdout.trim();
    await psql(databaseUrl, `UPDATE project_runtime_boxes SET status='running',container_id='${id}',started_at=NOW(),last_active_at=NOW() WHERE id=${boxId}`);
    return id;
  }

  beforeAll(async () => {
    await fs.mkdir(projectRoot, { recursive: true });
    const pgPort = 27000 + (process.pid % 1000);
    await docker('run', '-d', '--rm', '--name', pgName, '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=tower_test', '-p', `127.0.0.1:${pgPort}:5432`, 'postgres:16-alpine');
    for (let i = 0; i < 50; i += 1) {
      try { await docker('exec', pgName, 'pg_isready', '-U', 'postgres', '-d', 'tower_test'); break; }
      catch { if (i === 49) throw new Error('PostgreSQL not ready'); await new Promise(resolve => setTimeout(resolve, 200)); }
    }
    databaseUrl = `postgresql://postgres:test@127.0.0.1:${pgPort}/tower_test`;
    process.env.DATABASE_URL = databaseUrl;
    process.env.WORKSPACE_ROOT = workspaceRoot;
    process.env.TOWER_WORKBENCH_TOOL_STORE_ROOT = storeRoot;
    process.env.TOWER_EXPERIMENTAL_WORKBENCH_TOOLS_ENABLED = 'true';
    process.env.TOWER_EXPERIMENTAL_WORKBENCH_TOOL_PROJECT_IDS = JSON.stringify([projectId]);
    process.env.RUNTIME_BOX_IMAGE = 'tower-runtime-box:node22-python313';
    process.env.RUNTIME_BOX_MAX_RUNNING = '20';
    process.env.RUNTIME_BOX_MAX_RUNNING_PER_USER = '20';

    modules = {
      recreate: await import('./workbench-runtime-recreate.js'),
      tools: await import('./workbench-tools.js'),
      db: await import('../../db/pg-repo.js'),
      pg: await import('../../db/pg.js'),
    };
    const migrations = path.resolve(process.cwd(), 'packages/backend/db/migrations');
    for (const file of [
      '007_users.sql', '008_sessions.sql', '009_projects.sql', '075_project_runtime_boxes.sql',
      '077_project_runtime_box_node22_profile.sql', '078_runtime_box_service_supervision.sql', '079_runtime_box_preview_proxy.sql',
      '094_runtime_box_operator_tools_profile.sql', '150_runtime_box_workbench_tool_revisions.sql',
      '151_runtime_box_workbench_tool_commands.sql', '152_runtime_box_workbench_tool_store_refs.sql',
      '153_runtime_box_workbench_runtime_recreate_intents.sql',
    ]) await runFile('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', path.join(migrations, file)]);
    const boxSequenceStart = 100_000_000 + ((process.pid % 10_000) * 10_000) + (Number(BigInt(Date.now()) % 10_000n));
    await psql(databaseUrl, `INSERT INTO users(id,username,password_hash,role) VALUES(7,'operator','x','operator');
      INSERT INTO projects(id,name,root_path,user_id) VALUES('${projectId}','Recreate E2E','${projectRoot.replaceAll("'", "''")}',7);
      INSERT INTO sessions(id,name,user_id,project_id) VALUES('${sessionId}','Recreate E2E',7,'${projectId}');
      ALTER SEQUENCE project_runtime_boxes_id_seq RESTART WITH ${boxSequenceStart};
      INSERT INTO project_runtime_boxes(project_id,status,runtime_profile,project_root,created_by) VALUES('${projectId}','stopped','node22-python313','${projectRoot.replaceAll("'", "''")}',7);`);
    boxId = Number((await modules.db.queryOne('SELECT id FROM project_runtime_boxes WHERE project_id=$1', [projectId])).id);
    const rev1 = await createRevision(1, 'tool-old');
    const rev2 = await createRevision(2, 'tool-new');
    await psql(databaseUrl, `INSERT INTO runtime_box_workbench_tool_states(project_id,current_revision,health,storage_mode,updated_by_user_id)
      VALUES('${projectId}',2,'healthy','tower-managed-v1',7);
      UPDATE runtime_box_workbench_tool_revisions SET state='superseded' WHERE project_id='${projectId}' AND revision=1;`);
    const oldId = await startOldContainer(rev1.revisionPath);
    await psql(databaseUrl, `INSERT INTO runtime_box_workbench_tool_projections(box_id,project_id,revision,manifest_hash,store_ref,status)
      VALUES(${boxId},'${projectId}',1,'${rev1.hash}','projects/${projectId}/revisions/000001','mounted');
      INSERT INTO runtime_box_services(box_id,project_id,name,command,cwd,internal_port,status,visibility,pinned,purpose,owner_user_id,ttl_hours,created_by,process_pid)
      VALUES(${boxId},'${projectId}','api','sleep 1000','/workspace',8000,'running','private',true,'e2e impact',7,2,7,123);`);
    expect(oldId).toHaveLength(64);
    expect(rev2.manifest.revision).toBe(2);
  }, 120_000);

  afterAll(async () => {
    await modules?.pg?.closePgPool?.().catch(() => undefined);
    if (boxId) await docker('rm', '-f', `tower-box-${boxId}`).catch(() => undefined);
    await docker('rm', '-f', '-v', pgName).catch(() => undefined);
    await docker('run', '--rm', '-v', `${workspaceRoot}:/cleanup`, 'alpine:3.20', 'sh', '-c', 'chmod -R 777 /cleanup').catch(() => undefined);
    await docker('run', '--rm', '-v', `${storeRoot}:/cleanup`, 'alpine:3.20', 'sh', '-c', 'chmod -R 777 /cleanup').catch(() => undefined);
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(storeRoot, { recursive: true, force: true });
    for (const key of ['DATABASE_URL','WORKSPACE_ROOT','TOWER_WORKBENCH_TOOL_STORE_ROOT','TOWER_EXPERIMENTAL_WORKBENCH_TOOLS_ENABLED','TOWER_EXPERIMENTAL_WORKBENCH_TOOL_PROJECT_IDS','RUNTIME_BOX_IMAGE','RUNTIME_BOX_OPERATOR_IMAGE','RUNTIME_BOX_MAX_RUNNING','RUNTIME_BOX_MAX_RUNNING_PER_USER']) delete process.env[key];
  }, 120_000);

  it('guards stale/active/service impact, recreates successfully, then leaves a clear stopped/degraded state on create failure', async () => {
    const activityClient = await modules.pg.getPgPool().connect();
    await activityClient.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`runtime-box-activity:${boxId}`]);
    await expect(modules.recreate.previewWorkbenchRuntimeRecreate({ projectId, projectRoot, actor })).rejects.toMatchObject({ code: 'ACTIVE_EXECUTION' });
    await activityClient.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`runtime-box-activity:${boxId}`]);
    activityClient.release();

    const servicePreview = await modules.recreate.previewWorkbenchRuntimeRecreate({ projectId, projectRoot, actor });
    expect(servicePreview).toMatchObject({ revisions: { current: 2, mounted: 1, target: 2 }, services: { runningCount: 1 }, applyPolicy: { serviceImpactAcknowledgementRequired: true, automaticServiceRestart: false } });

    await modules.db.queryOne(
      `INSERT INTO projects(id,name,root_path,user_id) VALUES($1,'Foreign service fixture',$2,$3) RETURNING id`,
      [`${projectId}-foreign`, `${projectRoot}-foreign`, actor.userId],
    );
    await modules.db.queryOne(
      `INSERT INTO runtime_box_services (box_id,project_id,name,command,status,pinned,internal_port)
       VALUES ($1,$2,'foreign-project-service','sleep 1','running',false,4999) RETURNING id`,
      [boxId, `${projectId}-foreign`],
    );
    await expect(modules.recreate.previewWorkbenchRuntimeRecreate({ projectId, projectRoot, actor }))
      .rejects.toMatchObject({ code: 'SERVICE_IDENTITY_MISMATCH' });
    await modules.db.queryOne(`DELETE FROM runtime_box_services WHERE box_id=$1 AND name='foreign-project-service' RETURNING id`, [boxId]);
    await modules.db.queryOne(`DELETE FROM projects WHERE id=$1 RETURNING id`, [`${projectId}-foreign`]);

    await expect(modules.recreate.applyWorkbenchRuntimeRecreate({ projectId, projectRoot, intentId: servicePreview.intentId, proposalHash: servicePreview.proposalHash, confirmed: true, serviceImpactAcknowledged: false, actor }))
      .rejects.toMatchObject({ code: 'SERVICE_IMPACT_ACK_REQUIRED' });

    const stalePreview = await modules.recreate.previewWorkbenchRuntimeRecreate({ projectId, projectRoot, actor });
    await modules.db.queryOne(`UPDATE runtime_box_services SET process_pid=124 WHERE project_id=$1 AND name='api' RETURNING id`, [projectId]);
    await expect(modules.recreate.applyWorkbenchRuntimeRecreate({ projectId, projectRoot, intentId: stalePreview.intentId, proposalHash: stalePreview.proposalHash, confirmed: true, serviceImpactAcknowledged: true, actor }))
      .rejects.toMatchObject({ code: 'STALE_INTENT' });
    const beforeSuccess: any = await modules.db.queryOne('SELECT container_id FROM project_runtime_boxes WHERE id=$1', [boxId]);
    expect((await docker('inspect', '-f', '{{.State.Running}}', beforeSuccess.container_id)).stdout.trim()).toBe('true');

    const preview = await modules.recreate.previewWorkbenchRuntimeRecreate({ projectId, projectRoot, actor });
    const result: any = await modules.recreate.applyWorkbenchRuntimeRecreate({ projectId, projectRoot, intentId: preview.intentId, proposalHash: preview.proposalHash, confirmed: true, serviceImpactAcknowledged: true, actor });
    expect(result).toMatchObject({ ok: true, revisions: { previousMounted: 1, current: 2, mounted: 2 }, services: { autoRestarted: false, registryStatus: 'stopped' } });
    expect(result.runtime.containerId).not.toBe(beforeSuccess.container_id);
    await expect(docker('inspect', beforeSuccess.container_id)).rejects.toBeTruthy();
    expect((await docker('exec', result.runtime.containerId, 'sh', '-lc', '/workspace/.runtime-box/workbench-tools/active/bin/tool-new --version')).stdout).toContain('tool-new-2');
    const mounts = JSON.parse((await docker('inspect', '-f', '{{json .Mounts}}', result.runtime.containerId)).stdout);
    expect(mounts.find((mount: any) => mount.Destination === '/workspace/.runtime-box/workbench-tools/active')).toMatchObject({ RW: false });
    expect((await modules.db.queryOne(`SELECT status,process_pid FROM runtime_box_services WHERE project_id=$1 AND name='api'`, [projectId]))).toMatchObject({ status: 'stopped', process_pid: null });

    // Prepare one further stale target to exercise command-level start failure.
    const rev3 = await createRevision(3, 'tool-fail-target');
    await psql(databaseUrl, `UPDATE runtime_box_workbench_tool_revisions SET state='superseded' WHERE project_id='${projectId}' AND revision=2;
      UPDATE runtime_box_workbench_tool_revisions SET state='active' WHERE project_id='${projectId}' AND revision=3;
      UPDATE runtime_box_workbench_tool_states SET current_revision=3 WHERE project_id='${projectId}';
      UPDATE project_runtime_boxes SET runtime_profile='operator-tools' WHERE id=${boxId};
      UPDATE runtime_box_services SET status='running',process_pid=333,stopped_at=NULL WHERE project_id='${projectId}' AND name='api';`);
    process.env.RUNTIME_BOX_OPERATOR_IMAGE = `missing-a4b-image:${suffix}`;
    const failurePreview = await modules.recreate.previewWorkbenchRuntimeRecreate({ projectId, projectRoot, actor });
    const oldBeforeFailure: any = await modules.db.queryOne('SELECT container_id FROM project_runtime_boxes WHERE id=$1', [boxId]);
    await expect(modules.recreate.applyWorkbenchRuntimeRecreate({ projectId, projectRoot, intentId: failurePreview.intentId, proposalHash: failurePreview.proposalHash, confirmed: true, serviceImpactAcknowledged: true, actor }))
      .rejects.toThrow(/image|docker run|failed to start/i);
    const failedBox: any = await modules.db.queryOne('SELECT status,container_id,last_error FROM project_runtime_boxes WHERE id=$1', [boxId]);
    expect(failedBox.status).toBe('error');
    expect(failedBox.container_id).toBeNull();
    expect(failedBox.last_error).toBeTruthy();
    await expect(docker('inspect', oldBeforeFailure.container_id)).rejects.toBeTruthy();
    expect((await modules.db.queryOne(`SELECT status,process_pid FROM runtime_box_services WHERE project_id=$1 AND name='api'`, [projectId]))).toMatchObject({ status: 'stopped', process_pid: null });
    expect(rev3.manifest.revision).toBe(3);
  }, 120_000);
});
