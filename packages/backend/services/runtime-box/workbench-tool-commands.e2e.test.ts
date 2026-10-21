import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePgPool } from '../../db/pg.js';
import { query, queryOne } from '../../db/pg-repo.js';
import { applyWorkbenchToolChange, createCredentialFreeWorkbenchToolRunner, previewWorkbenchToolChange } from './workbench-tool-commands.js';
import { importProjectPrefixWorkbenchTools, inspectWorkbenchTools, installUvWorkbenchTool, rollbackWorkbenchTools } from './workbench-tools.js';

const runFile = promisify(execFile);
const run = process.env.WORKBENCH_TOOL_E2E === '1' ? describe : describe.skip;
const ACTIVE = '/workspace/.runtime-box/workbench-tools/active';

async function docker(...args: string[]) {
  return runFile('docker', args, { maxBuffer: 4_000_000 });
}

run('Workbench managed mutation disposable PostgreSQL + Docker E2E', () => {
  const pgName = `tower-workbench-mutation-pg-${process.pid}`;
  const projectId = `project-mutation-${process.pid}`;
  const sessionId = `session-mutation-${process.pid}`;
  const actor = { userId: 7, role: 'operator', sessionId };
  let root = '';
  let workspaceRoot = '';
  let projectRoot = '';
  let storeRoot = '';
  let pgPort = 0;
  let simulateRevision2DbFailure = false;
  let simulateRevision2ActivationMiss = false;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-workbench-mutation-e2e-'));
    workspaceRoot = path.join(root, 'workspace');
    projectRoot = path.join(workspaceRoot, 'projects', projectId);
    storeRoot = path.join(root, 'tower-data', 'runtime-box', 'workbench-tools');
    await fs.mkdir(projectRoot, { recursive: true });
    pgPort = 26000 + (process.pid % 1000);
    await docker('run', '-d', '--rm', '--name', pgName, '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=tower_test', '-p', `127.0.0.1:${pgPort}:5432`, 'postgres:16-alpine');
    for (let i = 0; i < 40; i += 1) {
      try {
        await docker('exec', pgName, 'pg_isready', '-U', 'postgres', '-d', 'tower_test');
        await runFile('psql', [`postgresql://postgres:test@127.0.0.1:${pgPort}/tower_test`, '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1']);
        break;
      }
      catch { if (i === 39) throw new Error('PostgreSQL not ready'); await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    process.env.DATABASE_URL = `postgresql://postgres:test@127.0.0.1:${pgPort}/tower_test`;
    process.env.WORKSPACE_ROOT = workspaceRoot;
    process.env.TOWER_WORKBENCH_TOOL_STORE_ROOT = storeRoot;
    process.env.TOWER_EXPERIMENTAL_WORKBENCH_TOOLS_ENABLED = 'true';
    process.env.TOWER_EXPERIMENTAL_WORKBENCH_TOOL_PROJECT_IDS = JSON.stringify([projectId]);
    const migrations = path.resolve(process.cwd(), 'packages/backend/db/migrations');
    for (const file of [
      '007_users.sql', '008_sessions.sql', '009_projects.sql', '075_project_runtime_boxes.sql',
      '077_project_runtime_box_node22_profile.sql', '094_runtime_box_operator_tools_profile.sql',
      '150_runtime_box_workbench_tool_revisions.sql', '151_runtime_box_workbench_tool_commands.sql',
      '152_runtime_box_workbench_tool_store_refs.sql', '154_runtime_box_workbench_import_action.sql',
    ]) await runFile('psql', [process.env.DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-f', path.join(migrations, file)]);
    await runFile('psql', [process.env.DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-c',
      `INSERT INTO users(id,username,password_hash,role) VALUES(7,'operator','x','operator');
       INSERT INTO projects(id,name,root_path,user_id) VALUES('${projectId}','Mutation E2E','${projectRoot.replaceAll("'", "''")}',7);
       INSERT INTO sessions(id,name,user_id,project_id) VALUES('${sessionId}','Mutation E2E',7,'${projectId}');
       INSERT INTO project_runtime_boxes(project_id,status,runtime_profile,project_root,created_by)
       VALUES('${projectId}','running','node22-python313','${projectRoot.replaceAll("'", "''")}',7);`]);
  }, 120_000);

  afterAll(async () => {
    await closePgPool().catch(() => undefined);
    await docker('rm', '-f', '-v', pgName).catch(() => undefined);
    if (root) await docker('run', '--rm', '-v', `${root}:/cleanup`, 'alpine:3.20', 'sh', '-c', 'chmod -R 777 /cleanup').catch(() => undefined);
    if (root) await fs.rm(root, { recursive: true, force: true });
    for (const key of ['DATABASE_URL', 'WORKSPACE_ROOT', 'TOWER_WORKBENCH_TOOL_STORE_ROOT', 'TOWER_EXPERIMENTAL_WORKBENCH_TOOLS_ENABLED', 'TOWER_EXPERIMENTAL_WORKBENCH_TOOL_PROJECT_IDS']) delete process.env[key];
  }, 120_000);

  const mutationExec = async (input: {
    command: string;
    cwd: '/workspace';
    credentialMode: 'none';
    candidateHostPath: string;
    candidateContainerPath: typeof ACTIVE;
    candidateMountMode: 'rw' | 'ro';
  }) => {
    expect(input.credentialMode).toBe('none');
    expect(input.candidateContainerPath).toBe(ACTIVE);
    expect(Object.keys(input).sort()).toEqual(['candidateContainerPath', 'candidateHostPath', 'candidateMountMode', 'command', 'credentialMode', 'cwd'].sort());
    try {
      const isolatedCommand = `cp -R /tower-project-source/. /workspace/ && ${input.command}`;
      const result = await docker('run', '--rm', '--user', `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`, '-e', 'UV_CACHE_DIR=/tmp/uv-cache',
        '--mount', `type=bind,src=${projectRoot},dst=/tower-project-source,readonly=true`,
        '--tmpfs', '/workspace:rw,nosuid,nodev,mode=0777',
        '--mount', `type=bind,src=${input.candidateHostPath},dst=${ACTIVE},readonly=${input.candidateMountMode === 'ro'}`,
        '-w', input.cwd, 'ghcr.io/astral-sh/uv:python3.12-bookworm-slim', 'sh', '-lc', isolatedCommand);
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error: any) {
      return { exitCode: Number(error.code ?? 1), stdout: error.stdout ?? '', stderr: error.stderr ?? String(error.message) };
    }
  };

  it('accepts the controlled import command kind while retaining the action allowlist', async () => {
    const preview = await previewWorkbenchToolChange({
      projectId,
      projectRoot,
      expectedRevision: null,
      action: { kind: 'install', manager: 'uv-tool', tool: { name: 'ruff', version: '0.12.0', entrypoints: ['ruff'] } },
      reason: 'constraint-fixture',
      actor,
    });
    await expect(queryOne(
      `INSERT INTO runtime_box_workbench_tool_commands
        (intent_id,project_id,actor_user_id,actor_session_id,idempotency_key,request_hash,action_kind)
       VALUES($1,$2,$3,$4,$5,$6,'import-project-prefix') RETURNING id`,
      [preview.intentId, projectId, actor.userId, sessionId, 'constraint-import', 'a'.repeat(64)],
    )).resolves.toBeDefined();
    await expect(queryOne(
      `INSERT INTO runtime_box_workbench_tool_commands
        (intent_id,project_id,actor_user_id,actor_session_id,idempotency_key,request_hash,action_kind)
       VALUES($1,$2,$3,$4,$5,$6,'arbitrary-action') RETURNING id`,
      [preview.intentId, projectId, actor.userId, sessionId, 'constraint-invalid', 'b'.repeat(64)],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps the Project read-only while allowing the command-scoped candidate to mutate', async () => {
    const candidate = path.join(storeRoot, 'projects', projectId, 'staging', 'project-ro-smoke');
    await fs.mkdir(candidate, { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'project-owned.txt'), 'original\n');

    const result = await mutationExec({
      command: `set -eu
        printf 'ephemeral-change\\n' > /workspace/project-owned.txt
        printf 'candidate-write\\n' > ${ACTIVE}/candidate-owned.txt
        test "$(cat /workspace/project-owned.txt)" = ephemeral-change
        test "$(cat ${ACTIVE}/candidate-owned.txt)" = candidate-write
        test -z "\${TOWER_CREDENTIAL_TEST_SECRET:-}"
        echo PROJECT_RO_CANDIDATE_RW_CREDENTIAL_FREE=yes`,
      cwd: '/workspace',
      credentialMode: 'none',
      candidateHostPath: candidate,
      candidateContainerPath: ACTIVE,
      candidateMountMode: 'rw',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PROJECT_RO_CANDIDATE_RW_CREDENTIAL_FREE=yes');
    expect(await fs.readFile(path.join(projectRoot, 'project-owned.txt'), 'utf8')).toBe('original\n');
    expect(await fs.readFile(path.join(candidate, 'candidate-owned.txt'), 'utf8')).toBe('candidate-write\n');
  });

  it('finalizes install/upgrade/rollback only after RW staging and RO final smoke, without Project-prefix payloads', async () => {
    const calls: Array<{ host: string; mode: string }> = [];
    const primitive = createCredentialFreeWorkbenchToolRunner(async input => {
      calls.push({ host: input.candidateHostPath, mode: input.candidateMountMode });
      return mutationExec(input);
    });
    const dependencies = {
      inspect: inspectWorkbenchTools,
      install: async (input: any) => {
        if (simulateRevision2DbFailure) {
          await queryOne(`CREATE OR REPLACE FUNCTION reject_revision_two() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.revision=2 THEN RAISE EXCEPTION 'injected revision two DB failure'; END IF; RETURN NEW; END $$`);
          await queryOne('CREATE TRIGGER reject_revision_two BEFORE INSERT ON runtime_box_workbench_tool_revisions FOR EACH ROW EXECUTE FUNCTION reject_revision_two()');
          try { return await installUvWorkbenchTool({ ...input, run: primitive }); }
          finally {
            await queryOne('DROP TRIGGER IF EXISTS reject_revision_two ON runtime_box_workbench_tool_revisions');
            await queryOne('DROP FUNCTION IF EXISTS reject_revision_two()');
            simulateRevision2DbFailure = false;
          }
        }
        if (simulateRevision2ActivationMiss) {
          await queryOne(`CREATE OR REPLACE FUNCTION hide_prepared_revision_two() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.revision=2 AND OLD.state='prepared' AND NEW.state='active' THEN RETURN NULL; END IF; RETURN NEW; END $$`);
          await queryOne(`CREATE TRIGGER hide_prepared_revision_two BEFORE UPDATE ON runtime_box_workbench_tool_revisions FOR EACH ROW EXECUTE FUNCTION hide_prepared_revision_two()`);
          try { return await installUvWorkbenchTool({ ...input, run: primitive }); }
          finally {
            await queryOne('DROP TRIGGER IF EXISTS hide_prepared_revision_two ON runtime_box_workbench_tool_revisions');
            await queryOne('DROP FUNCTION IF EXISTS hide_prepared_revision_two()');
            simulateRevision2ActivationMiss = false;
          }
        }
        return installUvWorkbenchTool({ ...input, run: primitive });
      },
      importProjectPrefix: (input: any) => importProjectPrefixWorkbenchTools({ ...input, run: primitive }),
      rollback: (input: any) => rollbackWorkbenchTools({ ...input, run: primitive }),
    };
    const apply = async (action: any, expectedRevision: number | null, key: string) => {
      const preview = await previewWorkbenchToolChange({ projectId, projectRoot, expectedRevision, action, reason: key, actor });
      return applyWorkbenchToolChange({ projectId, projectRoot, intentId: preview.intentId, proposalHash: preview.proposalHash, expectedRevision, idempotencyKey: key, confirmed: true, actor, dependencies }) as Promise<any>;
    };

    const first = await apply({ kind: 'install', manager: 'uv-tool', tool: { name: 'ruff', version: '0.12.0', entrypoints: ['ruff'] } }, null, 'install-ruff');
    expect(first).toMatchObject({ revision: 1, activation: 'pointer_updated', runtime: { recreateStatus: 'unknown', recreateRequired: null, mountedRevision: null } });
    const revision1 = path.join(storeRoot, 'projects', projectId, 'revisions', '000001');
    expect(calls.some(call => call.mode === 'rw' && call.host.includes('/staging/'))).toBe(true);
    expect(calls.some(call => call.mode === 'ro' && call.host === revision1)).toBe(true);
    await expect(fs.access(path.join(projectRoot, '.runtime-box', 'workbench-tools', 'revisions', '000001'))).rejects.toBeTruthy();

    await queryOne(`INSERT INTO runtime_box_workbench_tool_projections(box_id,project_id,revision,manifest_hash,store_ref,status)
      SELECT b.id,$1,1,r.manifest_hash,r.store_ref,'mounted' FROM project_runtime_boxes b
      JOIN runtime_box_workbench_tool_revisions r ON r.project_id=$1 AND r.revision=1 WHERE b.project_id=$1 RETURNING box_id`, [projectId]);

    simulateRevision2DbFailure = true;
    await expect(apply({ kind: 'install', manager: 'uv-tool', tool: { name: 'cowsay', version: '6.1', entrypoints: ['cowsay'] } }, 1, 'injected-db-failure'))
      .rejects.toThrow('injected revision two DB failure');
    expect((await queryOne<any>('SELECT current_revision FROM runtime_box_workbench_tool_states WHERE project_id=$1', [projectId]))?.current_revision).toBe(1);
    expect(await queryOne('SELECT 1 FROM runtime_box_workbench_tool_revisions WHERE project_id=$1 AND revision=2', [projectId])).toBeUndefined();
    await expect(apply({ kind: 'install', manager: 'uv-tool', tool: { name: 'cowsay', version: '6.1', entrypoints: ['cowsay'] } }, 1, 'orphan-reuse-refused'))
      .rejects.toThrow('already exists');
    expect((await queryOne<any>('SELECT current_revision FROM runtime_box_workbench_tool_states WHERE project_id=$1', [projectId]))?.current_revision).toBe(1);
    await fs.rename(path.join(storeRoot, 'projects', projectId, 'revisions', '000002'), path.join(storeRoot, 'projects', projectId, 'revisions', '999999'));

    simulateRevision2ActivationMiss = true;
    await expect(apply({ kind: 'install', manager: 'uv-tool', tool: { name: 'cowsay', version: '6.1', entrypoints: ['cowsay'] } }, 1, 'injected-activation-miss'))
      .rejects.toThrow('Prepared Workbench revision activation failed');
    expect((await queryOne<any>('SELECT current_revision FROM runtime_box_workbench_tool_states WHERE project_id=$1', [projectId]))?.current_revision).toBe(1);
    expect(await queryOne('SELECT 1 FROM runtime_box_workbench_tool_revisions WHERE project_id=$1 AND revision=1 AND state=$2', [projectId, 'active'])).toBeDefined();
    expect(await queryOne('SELECT 1 FROM runtime_box_workbench_tool_revisions WHERE project_id=$1 AND revision=2 AND state=$2', [projectId, 'failed'])).toBeDefined();
    await fs.rename(path.join(storeRoot, 'projects', projectId, 'revisions', '000002'), path.join(storeRoot, 'projects', projectId, 'revisions', '999998'));

    const second = await apply({ kind: 'install', manager: 'uv-tool', tool: { name: 'cowsay', version: '6.1', entrypoints: ['cowsay'] } }, 1, 'install-cowsay');
    expect(second).toMatchObject({ revision: 3, runtime: { recreateStatus: 'required', mountedRevision: 1, currentRevision: 3 } });
    const revision2 = path.join(storeRoot, 'projects', projectId, 'revisions', '000003');
    const recreatedName = `tower-workbench-recreated-${process.pid}`;
    await docker('run', '-d', '--rm', '--name', recreatedName, '--mount', `type=bind,src=${projectRoot},dst=/workspace,readonly=false`, '--mount', `type=bind,src=${revision2},dst=${ACTIVE},readonly=true`, 'ghcr.io/astral-sh/uv:python3.12-bookworm-slim', 'sleep', 'infinity');
    try {
      expect((await docker('exec', recreatedName, 'sh', '-lc', `${ACTIVE}/bin/ruff --version`)).stdout).toContain('0.12.0');
      expect((await docker('exec', recreatedName, 'sh', '-lc', `${ACTIVE}/bin/cowsay --version`)).stdout).toContain('6.1');
    } finally { await docker('rm', '-f', recreatedName).catch(() => undefined); }

    const rollback = await apply({ kind: 'rollback', targetRevision: 1 }, 3, 'rollback-to-1');
    expect(rollback.revision).toBe(4);
    const rows = await query<any>('SELECT revision,previous_revision,source_revision,storage_kind,store_ref,store_manifest_hash,state FROM runtime_box_workbench_tool_revisions WHERE project_id=$1 ORDER BY revision', [projectId]);
    expect(rows).toHaveLength(4);
    expect(rows[1]).toMatchObject({ revision: 2, state: 'failed' });
    expect(rows[3]).toMatchObject({ revision: 4, previous_revision: 3, source_revision: 1, storage_kind: 'tower-managed-v1', state: 'rollback' });
    expect(rows.every(row => row.store_ref && row.store_manifest_hash)).toBe(true);
  }, 180_000);
});
