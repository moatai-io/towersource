import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runFile = promisify(execFile);
const run = process.env.WORKBENCH_RECOVERY_E2E === '1' ? describe : describe.skip;
async function docker(...args: string[]) { return runFile('docker', args, { maxBuffer: 4_000_000 }); }

run('Workbench recovery disposable PostgreSQL + managed-store E2E', () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const pgName = `tower-workbench-recovery-pg-${suffix}`;
  const projectId = `project-recovery-${process.pid}`;
  const sessionId = `session-recovery-${process.pid}`;
  const actor = { userId: 7, role: 'operator', sessionId };
  const workspaceRoot = path.join(os.tmpdir(), `tower-recovery-workspace-${suffix}`);
  const projectRoot = path.join(workspaceRoot, 'projects', projectId);
  const storeRoot = path.join(os.tmpdir(), `tower-recovery-store-${suffix}`);
  let databaseUrl = '';
  let modules: any;

  beforeAll(async () => {
    await fs.mkdir(projectRoot, { recursive: true });
    await docker('run', '-d', '--rm', '--name', pgName,
      '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=tower_test',
      '-p', '127.0.0.1::5432', 'postgres:16-alpine');
    const mapped = await docker('port', pgName, '5432/tcp');
    const port = Number(mapped.stdout.trim().match(/:(\d+)$/)?.[1]);
    databaseUrl = `postgresql://postgres:test@127.0.0.1:${port}/tower_test`;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { await runFile('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1']); break; }
      catch { if (attempt === 39) throw new Error('Disposable PostgreSQL did not become ready'); await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    process.env.DATABASE_URL = databaseUrl;
    process.env.WORKSPACE_ROOT = workspaceRoot;
    process.env.TOWER_WORKBENCH_TOOL_STORE_ROOT = storeRoot;
    process.env.TOWER_EXPERIMENTAL_WORKBENCH_TOOLS_ENABLED = 'true';
    process.env.TOWER_EXPERIMENTAL_WORKBENCH_TOOL_PROJECT_IDS = JSON.stringify([projectId]);
    modules = {
      recovery: await import('./workbench-tool-recovery.js'),
      db: await import('../../db/pg-repo.js'),
      pg: await import('../../db/pg.js'),
    };
    const migrations = path.resolve(process.cwd(), 'packages/backend/db/migrations');
    for (const file of [
      '007_users.sql', '008_sessions.sql', '009_projects.sql',
      '075_project_runtime_boxes.sql', '077_project_runtime_box_node22_profile.sql',
      '150_runtime_box_workbench_tool_revisions.sql', '151_runtime_box_workbench_tool_commands.sql',
      '152_runtime_box_workbench_tool_store_refs.sql', '154_runtime_box_workbench_import_action.sql',
      '160_runtime_box_workbench_recovery_intents.sql',
    ]) await runFile('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', path.join(migrations, file)]);
    await modules.db.queryOne(`INSERT INTO users(id,username,password_hash,role) VALUES(7,'operator','x','operator') RETURNING id`);
    await modules.db.queryOne(`INSERT INTO projects(id,name,root_path,user_id) VALUES($1,'Recovery E2E',$2,7) RETURNING id`, [projectId, projectRoot]);
    await modules.db.queryOne(`INSERT INTO sessions(id,name,user_id,project_id) VALUES($1,'Recovery E2E',7,$2) RETURNING id`, [sessionId, projectId]);
    await modules.db.queryOne(`INSERT INTO runtime_box_workbench_tool_revisions
      (project_id,revision,state,manager,manifest,manifest_hash,prefix_relpath,reason,requested_by_user_id,storage_kind,store_ref,store_manifest_hash,activated_at)
      VALUES($1,1,'active','uv-tool','{}'::jsonb,$2,'.runtime-box/workbench-tools/revisions/000001','e2e',7,'tower-managed-v1',$3,$2,NOW()) RETURNING revision`,
    [projectId, 'a'.repeat(64), `projects/${projectId}/revisions/000001`]);
    await modules.db.queryOne(`INSERT INTO runtime_box_workbench_tool_states(project_id,current_revision,health,storage_mode,updated_by_user_id)
      VALUES($1,1,'healthy','tower-managed-v1',7) RETURNING project_id`, [projectId]);
  }, 120_000);

  afterAll(async () => {
    await modules?.pg?.closePgPool?.().catch(() => undefined);
    await docker('rm', '-f', pgName).catch(() => undefined);
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(storeRoot, { recursive: true, force: true });
    for (const key of ['DATABASE_URL', 'WORKSPACE_ROOT', 'TOWER_WORKBENCH_TOOL_STORE_ROOT', 'TOWER_EXPERIMENTAL_WORKBENCH_TOOLS_ENABLED', 'TOWER_EXPERIMENTAL_WORKBENCH_TOOL_PROJECT_IDS']) delete process.env[key];
  }, 120_000);

  async function createInterruptedCommand(key: string, status: 'reserved' | 'running' = 'running') {
    const intent = await modules.db.queryOne(`INSERT INTO runtime_box_workbench_tool_change_intents
      (project_id,actor_user_id,actor_session_id,actor_role,expected_revision,action,reason,proposal_hash,risk,expires_at)
      VALUES($1,7,$2,'operator',1,'{"kind":"install","manager":"uv-tool","tool":{"name":"fixture","version":"1","entrypoints":["fixture"]}}'::jsonb,$3,$4,'high',NOW()+INTERVAL '30 minutes') RETURNING id`,
    [projectId, sessionId, key, 'c'.repeat(64)]);
    const command = await modules.db.queryOne(`INSERT INTO runtime_box_workbench_tool_commands
      (intent_id,project_id,actor_user_id,actor_session_id,idempotency_key,request_hash,action_kind,expected_revision,before_revision,status,started_at,created_at)
      VALUES($1,$2,7,$3,$4,$5,'install',1,1,$6,NOW()-INTERVAL '1 hour',NOW()-INTERVAL '1 hour') RETURNING id`,
    [intent.id, projectId, sessionId, key, 'd'.repeat(64), status]);
    const candidate = path.join(storeRoot, 'projects', projectId, 'staging', command.id);
    await fs.mkdir(candidate, { recursive: true });
    await fs.writeFile(path.join(candidate, 'partial-install.txt'), 'orphan evidence\n');
    return { intent, command, candidate };
  }

  it('cleans one approved orphan candidate, preserves ledger evidence, and rejects intent reuse', async () => {
    const fixture = await createInterruptedCommand('recovery-success');
    const inspection = await modules.recovery.inspectWorkbenchToolRecovery({ projectId });
    expect(inspection).toMatchObject({ disposition: 'auto_cleanup_candidate', currentRevision: 1, safeCleanupCandidates: [fixture.command.id], orphanFinalizedRevisions: [] });

    const preview = await modules.recovery.previewWorkbenchToolRecovery({ projectId, commandId: fixture.command.id, actor });
    const result = await modules.recovery.applyWorkbenchToolRecovery({
      projectId, intentId: preview.intentId, proposalHash: preview.proposalHash, confirmed: true, actor,
    });
    expect(result).toEqual({ commandId: fixture.command.id, candidateRemoved: true, activeRevisionChanged: false, commandEvidencePreserved: true });
    await expect(fs.access(fixture.candidate)).rejects.toBeTruthy();
    expect(await modules.db.queryOne(`SELECT status,error_code,completed_at FROM runtime_box_workbench_tool_commands WHERE id=$1`, [fixture.command.id]))
      .toMatchObject({ status: 'failed', error_code: 'RECOVERED_ORPHAN_CANDIDATE' });
    expect(await modules.db.queryOne(`SELECT status,consumed_at,result FROM runtime_box_workbench_recovery_intents WHERE id=$1`, [preview.intentId]))
      .toMatchObject({ status: 'succeeded', result: { commandId: fixture.command.id, candidateRemoved: true, activeRevisionChanged: false, commandEvidencePreserved: true } });
    expect((await modules.db.queryOne(`SELECT current_revision FROM runtime_box_workbench_tool_states WHERE project_id=$1`, [projectId])).current_revision).toBe(1);
    await expect(modules.recovery.applyWorkbenchToolRecovery({
      projectId, intentId: preview.intentId, proposalHash: preview.proposalHash, confirmed: true, actor,
    })).rejects.toMatchObject({ code: 'INTENT_EXPIRED_OR_CONSUMED' });
  }, 30_000);

  it('rejects pointer drift before deletion and leaves the approval unused', async () => {
    const fixture = await createInterruptedCommand('recovery-drift');
    const preview = await modules.recovery.previewWorkbenchToolRecovery({ projectId, commandId: fixture.command.id, actor });
    await modules.db.queryOne(`INSERT INTO runtime_box_workbench_tool_revisions
      (project_id,revision,state,previous_revision,manager,manifest,manifest_hash,prefix_relpath,reason,requested_by_user_id,storage_kind,store_ref,store_manifest_hash,activated_at)
      VALUES($1,2,'rollback',1,'uv-tool','{}'::jsonb,$2,'.runtime-box/workbench-tools/revisions/000002','e2e drift',7,'tower-managed-v1',$3,$2,NOW()) RETURNING revision`,
    [projectId, 'b'.repeat(64), `projects/${projectId}/revisions/000002`]);
    await modules.db.queryOne(`UPDATE runtime_box_workbench_tool_states SET current_revision=2 WHERE project_id=$1 RETURNING project_id`, [projectId]);

    await expect(modules.recovery.applyWorkbenchToolRecovery({
      projectId, intentId: preview.intentId, proposalHash: preview.proposalHash, confirmed: true, actor,
    })).rejects.toMatchObject({ code: 'STALE_RECOVERY_INTENT' });
    await expect(fs.access(fixture.candidate)).resolves.toBeUndefined();
    expect(await modules.db.queryOne(`SELECT status,consumed_at FROM runtime_box_workbench_recovery_intents WHERE id=$1`, [preview.intentId]))
      .toMatchObject({ status: 'previewed', consumed_at: null });
    expect(await modules.db.queryOne(`SELECT status FROM runtime_box_workbench_tool_commands WHERE id=$1`, [fixture.command.id]))
      .toMatchObject({ status: 'running' });
  }, 30_000);

  it('classifies a finalized revision without a DB ledger row as operator review', async () => {
    await modules.db.queryOne(`UPDATE runtime_box_workbench_tool_states SET current_revision=1 WHERE project_id=$1 RETURNING project_id`, [projectId]);
    const revisionPath = path.join(storeRoot, 'projects', projectId, 'revisions', '000003');
    await fs.mkdir(revisionPath, { recursive: true });
    await fs.writeFile(path.join(revisionPath, 'manifest.json'), '{}\n');

    const inspection = await modules.recovery.inspectWorkbenchToolRecovery({ projectId });
    expect(inspection.disposition).toBe('operator_review');
    expect(inspection.orphanFinalizedRevisions).toEqual([3]);
    expect(inspection.safeCleanupCandidates).toEqual([]);
    expect(inspection.blockers.some((blocker: string) => blocker.includes('without DB ledger rows: 3'))).toBe(true);
    await expect(fs.access(revisionPath)).resolves.toBeUndefined();
  }, 30_000);
});
