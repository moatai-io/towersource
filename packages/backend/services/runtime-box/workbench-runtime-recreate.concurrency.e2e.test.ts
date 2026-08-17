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

run('Workbench Runtime recreate Box-lock concurrency E2E', () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const pgName = `tower-workbench-recreate-lock-pg-${suffix}`;
  const projectId = `project-recreate-lock-${process.pid}`;
  const sessionId = `session-recreate-lock-${process.pid}`;
  const actor = { userId: 7, role: 'operator', sessionId };
  const workspaceRoot = path.join(os.tmpdir(), `tower-a4b-lock-workspace-${suffix}`);
  const projectRoot = path.join(workspaceRoot, 'projects', projectId);
  const storeRoot = path.join(os.tmpdir(), `tower-a4b-lock-store-${suffix}`);
  let databaseUrl = '';
  let boxId = 0;
  let modules: any;

  beforeAll(async () => {
    await fs.mkdir(projectRoot, { recursive: true });
    const pgPort = 28000 + (process.pid % 1000);
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
    modules = { recreate: await import('./workbench-runtime-recreate.js'), tools: await import('./workbench-tools.js'), db: await import('../../db/pg-repo.js'), pg: await import('../../db/pg.js') };
    const migrations = path.resolve(process.cwd(), 'packages/backend/db/migrations');
    for (const file of ['007_users.sql','008_sessions.sql','009_projects.sql','075_project_runtime_boxes.sql','077_project_runtime_box_node22_profile.sql','078_runtime_box_service_supervision.sql','079_runtime_box_preview_proxy.sql','094_runtime_box_operator_tools_profile.sql','150_runtime_box_workbench_tool_revisions.sql','151_runtime_box_workbench_tool_commands.sql','152_runtime_box_workbench_tool_store_refs.sql','153_runtime_box_workbench_runtime_recreate_intents.sql']) {
      await runFile('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', path.join(migrations, file)]);
    }
    const boxSequenceStart = 300_000_000 + ((process.pid % 10_000) * 10_000) + (Number(BigInt(Date.now()) % 10_000n));
    await psql(databaseUrl, `INSERT INTO users(id,username,password_hash,role) VALUES(7,'operator','x','operator');
      INSERT INTO projects(id,name,root_path,user_id) VALUES('${projectId}','Recreate Lock E2E','${projectRoot.replaceAll("'", "''")}',7);
      INSERT INTO sessions(id,name,user_id,project_id) VALUES('${sessionId}','Recreate Lock E2E',7,'${projectId}');
      ALTER SEQUENCE project_runtime_boxes_id_seq RESTART WITH ${boxSequenceStart};
      INSERT INTO project_runtime_boxes(project_id,status,runtime_profile,project_root,created_by) VALUES('${projectId}','stopped','node22-python313','${projectRoot.replaceAll("'", "''")}',7);`);
    boxId = Number((await modules.db.queryOne('SELECT id FROM project_runtime_boxes WHERE project_id=$1', [projectId])).id);
    const makeRevision = async (revision: number, name: string, state: string) => {
      const revisionName = String(revision).padStart(6, '0');
      const revisionPath = path.join(storeRoot, 'projects', projectId, 'revisions', revisionName);
      await fs.mkdir(path.join(revisionPath, 'bin'), { recursive: true });
      await fs.writeFile(path.join(revisionPath, 'bin', name), `#!/bin/sh\necho ${name}-${revision}\n`, { mode: 0o755 });
      const manifest = { schemaVersion: 1, workbenchId: projectId, revision, createdAt: new Date().toISOString(), createdBy: { userId: 7, sessionId, jobId: null }, manager: 'uv-tool', tools: [{ name, version: String(revision), entrypoints: [name], installSpec: `${name}==${revision}` }], paths: { prefix: `.runtime-box/workbench-tools/revisions/${revisionName}`, bin: `.runtime-box/workbench-tools/revisions/${revisionName}/bin` }, validation: { status: 'passed', commands: [] }, previousRevision: revision === 1 ? null : revision - 1, rollbackRef: null };
      const hash = modules.tools.stableManifestHash(manifest);
      await fs.writeFile(path.join(revisionPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      await psql(databaseUrl, `INSERT INTO runtime_box_workbench_tool_revisions(project_id,revision,state,previous_revision,manager,manifest,manifest_hash,prefix_relpath,validation,reason,requested_by_user_id,storage_kind,store_ref,store_manifest_hash,activated_at) VALUES('${projectId}',${revision},'${state}',${revision === 1 ? 'NULL' : revision - 1},'uv-tool','${JSON.stringify(manifest).replaceAll("'", "''")}'::jsonb,'${hash}','${manifest.paths.prefix}','{}'::jsonb,'e2e',7,'tower-managed-v1','projects/${projectId}/revisions/${revisionName}','${hash}',NOW())`);
      return { revisionPath, hash };
    };
    const oldRevision = await makeRevision(1, 'old-tool', 'superseded');
    await makeRevision(2, 'new-tool', 'active');
    await makeRevision(3, 'mutated-tool', 'superseded');
    await psql(databaseUrl, `INSERT INTO runtime_box_workbench_tool_states(project_id,current_revision,health,storage_mode,updated_by_user_id) VALUES('${projectId}',2,'healthy','tower-managed-v1',7);`);
    const container = (await docker('run','-d','--name',`tower-box-${boxId}`,'--mount',`type=bind,src=${projectRoot},dst=/workspace,readonly=false`,'--mount',`type=bind,src=${oldRevision.revisionPath},dst=/workspace/.runtime-box/workbench-tools/active,readonly=true`,'--label',`tower.box.id=${boxId}`,'--label',`tower.project.id=${projectId}`,'tower-runtime-box:node22-python313','sleep','infinity')).stdout.trim();
    await psql(databaseUrl, `UPDATE project_runtime_boxes SET status='running',container_id='${container}',started_at=NOW(),last_active_at=NOW() WHERE id=${boxId}; INSERT INTO runtime_box_workbench_tool_projections(box_id,project_id,revision,manifest_hash,store_ref,status) VALUES(${boxId},'${projectId}',1,'${oldRevision.hash}','projects/${projectId}/revisions/000001','mounted');`);
  }, 120_000);

  afterAll(async () => {
    await modules?.pg?.closePgPool?.().catch(() => undefined);
    if (boxId) await docker('rm','-f',`tower-box-${boxId}`).catch(() => undefined);
    await docker('rm','-f',pgName).catch(() => undefined);
    await docker('run','--rm','-v',`${workspaceRoot}:/cleanup`,'alpine:3.20','sh','-c','chmod -R 777 /cleanup').catch(() => undefined);
    await docker('run','--rm','-v',`${storeRoot}:/cleanup`,'alpine:3.20','sh','-c','chmod -R 777 /cleanup').catch(() => undefined);
    await fs.rm(workspaceRoot,{recursive:true,force:true}); await fs.rm(storeRoot,{recursive:true,force:true});
    for (const key of ['DATABASE_URL','WORKSPACE_ROOT','TOWER_WORKBENCH_TOOL_STORE_ROOT','TOWER_EXPERIMENTAL_WORKBENCH_TOOLS_ENABLED','TOWER_EXPERIMENTAL_WORKBENCH_TOOL_PROJECT_IDS','RUNTIME_BOX_IMAGE','RUNTIME_BOX_MAX_RUNNING','RUNTIME_BOX_MAX_RUNNING_PER_USER']) delete process.env[key];
  }, 120_000);

  it('rejects a mutation that changes current target after validation but before the activity lock, preserving the old container and unused intent', async () => {
    const activity = async () => ({ status: 'inactive' as const, activeExecutions: 0 as const, evidence: 'activity-advisory-lock' as const });
    const preview = await modules.recreate.previewWorkbenchRuntimeRecreate({ projectId, projectRoot, actor, dependencies: { ...modules.recreate.defaultWorkbenchRuntimeRecreateDependencies, activity: async () => ({ status: 'inactive', activeExecutions: 0, evidence: 'activity-advisory-lock' }) } });
    const oldContainer = (await modules.db.queryOne('SELECT container_id FROM project_runtime_boxes WHERE id=$1', [boxId])).container_id;
    await psql(databaseUrl, `UPDATE runtime_box_workbench_tool_revisions SET state='superseded' WHERE project_id='${projectId}' AND revision=2;
      UPDATE runtime_box_workbench_tool_revisions SET state='active' WHERE project_id='${projectId}' AND revision=3;
      UPDATE runtime_box_workbench_tool_states SET current_revision=3 WHERE project_id='${projectId}';`);
    let destructiveEntries = 0;
    const dependencies = { ...modules.recreate.defaultWorkbenchRuntimeRecreateDependencies, activity, recreate: async (input: any) => { destructiveEntries += 1; return modules.recreate.defaultWorkbenchRuntimeRecreateDependencies.recreate(input); } };
    await expect(modules.recreate.applyWorkbenchRuntimeRecreate({ projectId, projectRoot, intentId: preview.intentId, proposalHash: preview.proposalHash, confirmed: true, serviceImpactAcknowledged: false, actor, dependencies }))
      .rejects.toMatchObject({ code: 'STALE_INTENT' });
    expect(destructiveEntries).toBe(0);
    expect((await docker('inspect', '-f', '{{.State.Running}}', oldContainer)).stdout.trim()).toBe('true');
    expect(await modules.db.queryOne('SELECT status,consumed_at FROM runtime_box_workbench_runtime_recreate_intents WHERE id=$1', [preview.intentId]))
      .toMatchObject({ status: 'previewed', consumed_at: null });
    await psql(databaseUrl, `UPDATE runtime_box_workbench_tool_revisions SET state='superseded' WHERE project_id='${projectId}' AND revision=3;
      UPDATE runtime_box_workbench_tool_revisions SET state='active' WHERE project_id='${projectId}' AND revision=2;
      UPDATE runtime_box_workbench_tool_states SET current_revision=2 WHERE project_id='${projectId}';`);
  }, 120_000);

  it('allows only one of two exact intents to enter the destructive lifecycle', async () => {
    const activity = async () => ({ status: 'inactive' as const, activeExecutions: 0 as const, evidence: 'activity-advisory-lock' as const });
    const [a,b] = await Promise.all([
      modules.recreate.previewWorkbenchRuntimeRecreate({ projectId, projectRoot, actor, dependencies: { ...modules.recreate.defaultWorkbenchRuntimeRecreateDependencies, activity } }),
      modules.recreate.previewWorkbenchRuntimeRecreate({ projectId, projectRoot, actor, dependencies: { ...modules.recreate.defaultWorkbenchRuntimeRecreateDependencies, activity } }),
    ]);
    const entered: string[] = [];
    const wrap = (intentId: string) => ({
      ...modules.recreate.defaultWorkbenchRuntimeRecreateDependencies,
      activity,
      recreate: async (input: any) => { entered.push(intentId); await new Promise(resolve => setTimeout(resolve, 150)); return modules.recreate.defaultWorkbenchRuntimeRecreateDependencies.recreate(input); },
    });
    const settled = await Promise.allSettled([
      modules.recreate.applyWorkbenchRuntimeRecreate({ projectId, projectRoot, intentId: a.intentId, proposalHash: a.proposalHash, confirmed: true, serviceImpactAcknowledged: false, actor, dependencies: wrap(a.intentId) }),
      modules.recreate.applyWorkbenchRuntimeRecreate({ projectId, projectRoot, intentId: b.intentId, proposalHash: b.proposalHash, confirmed: true, serviceImpactAcknowledged: false, actor, dependencies: wrap(b.intentId) }),
    ]);
    expect(entered).toHaveLength(1);
    const settledSummary = settled.map(item => item.status === 'fulfilled' ? item : { status: item.status, reason: { name: item.reason?.name, message: item.reason?.message, code: item.reason?.code, reason: item.reason?.reason, stack: item.reason?.stack } });
    expect(settled.filter(item => item.status === 'fulfilled'), JSON.stringify(settledSummary)).toHaveLength(1);
    expect(settled.filter(item => item.status === 'rejected')).toHaveLength(1);
    const rows = await modules.db.query('SELECT status FROM runtime_box_workbench_runtime_recreate_intents WHERE id = ANY($1::uuid[]) ORDER BY created_at', [[a.intentId, b.intentId]]);
    expect(rows.map((row: any) => row.status).sort()).toEqual(['previewed','succeeded']);
  }, 120_000);
});
