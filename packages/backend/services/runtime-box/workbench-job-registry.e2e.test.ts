import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runFile = promisify(execFile);
const run = process.env.WORKBENCH_JOB_E2E === '1' ? describe : describe.skip;
async function docker(...args: string[]) { return runFile('docker', args, { maxBuffer: 4_000_000 }); }

run('Workbench durable Job PostgreSQL E2E', () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const pgName = `tower-workbench-job-pg-${suffix}`;
  const projectId = `project-job-${process.pid}`;
  const sessionId = `session-job-${process.pid}`;
  let modules: any;
  let databaseUrl = '';

  beforeAll(async () => {
    await docker('run', '-d', '--rm', '--name', pgName, '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=tower_test', '-p', '127.0.0.1::5432', 'postgres:16-alpine');
    const mapped = await docker('port', pgName, '5432/tcp');
    const port = Number(mapped.stdout.trim().match(/:(\d+)$/)?.[1]);
    databaseUrl = `postgresql://postgres:test@127.0.0.1:${port}/tower_test`;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { await runFile('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1']); break; }
      catch { if (attempt === 39) throw new Error('Disposable PostgreSQL did not become ready'); await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    process.env.DATABASE_URL = databaseUrl;
    modules = { jobs: await import('./workbench-job-registry.js'), db: await import('../../db/pg-repo.js'), pg: await import('../../db/pg.js') };
    const migrations = path.resolve(process.cwd(), 'packages/backend/db/migrations');
    for (const file of ['007_users.sql', '008_sessions.sql', '009_projects.sql', '075_project_runtime_boxes.sql', '077_project_runtime_box_node22_profile.sql', '150_runtime_box_workbench_tool_revisions.sql', '162_runtime_box_workbench_jobs.sql', '163_runtime_box_workbench_job_claims.sql', '164_runtime_box_workbench_job_claim_indexes.sql']) {
      await runFile('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', path.join(migrations, file)]);
    }
    await modules.db.queryOne(`INSERT INTO users(id,username,password_hash,role) VALUES(7,'operator','x','operator') RETURNING id`);
    await modules.db.queryOne(`INSERT INTO projects(id,name,root_path,user_id) VALUES($1,'Job E2E','/tmp/job-e2e',7) RETURNING id`, [projectId]);
    await modules.db.queryOne(`INSERT INTO sessions(id,name,user_id,project_id) VALUES($1,'Job E2E',7,$2) RETURNING id`, [sessionId, projectId]);
    await modules.db.queryOne(`INSERT INTO runtime_box_workbench_tool_states(project_id,current_revision,health,updated_by_user_id) VALUES($1,NULL,'healthy',7) RETURNING project_id`, [projectId]);
  }, 120_000);

  afterAll(async () => {
    await modules?.pg?.closePgPool?.().catch(() => undefined);
    await docker('rm', '-f', pgName).catch(() => undefined);
    delete process.env.DATABASE_URL;
  }, 120_000);

  it('persists success, failure, cancellation, attribution, and environment key redaction', async () => {
    const success = await modules.jobs.createWorkbenchJob({ projectId, userId: 7, sessionId, command: 'printf ok', timeoutSec: 20, env: { SECRET_TOKEN: 'never-persist-me' } });
    expect(success).toMatchObject({ status: 'queued', provider_kind: 'local-runtime', environment_keys: ['SECRET_TOKEN'] });
    const successClaim = await modules.jobs.claimWorkbenchJob({ jobId: success.id, projectId, runnerId: 'e2e-runner' });
    const succeeded = await modules.jobs.runClaimedWorkbenchJob({ job: successClaim, run: async () => ({ exit_code: 0, stdout: 'ok', stderr: '', duration_ms: 2, timed_out: false, oom_killed: false, runtime_context: {} }) });
    expect(succeeded.job).toMatchObject({ status: 'succeeded', exit_code: 0, stdout_text: 'ok', requested_by_session_id: sessionId });

    const failedJob = await modules.jobs.createWorkbenchJob({ projectId, userId: 7, sessionId, command: 'exit 3' });
    const failedClaim = await modules.jobs.claimWorkbenchJob({ jobId: failedJob.id, projectId, runnerId: 'e2e-runner' });
    const failed = await modules.jobs.runClaimedWorkbenchJob({ job: failedClaim, run: async () => ({ exit_code: 3, stdout: '', stderr: 'bad', duration_ms: 1, timed_out: false, oom_killed: false, runtime_context: {} }) });
    expect(failed.job).toMatchObject({ status: 'failed', exit_code: 3, error_code: 'NON_ZERO_EXIT', stderr_text: 'bad' });

    const queued = await modules.jobs.createWorkbenchJob({ projectId, userId: 7, sessionId, command: 'sleep 10' });
    expect(await modules.jobs.cancelWorkbenchJob(projectId, queued.id)).toMatchObject({ status: 'cancelled' });
    expect(await modules.jobs.claimWorkbenchJob({ jobId: queued.id, projectId, runnerId: 'e2e-runner' })).toBeUndefined();

    const rows = await modules.jobs.listWorkbenchJobs(projectId, 10);
    expect(rows.map((row: any) => row.status).sort()).toEqual(['cancelled', 'failed', 'succeeded']);
    const raw = await modules.db.queryOne(`SELECT environment_keys::text AS keys, row_to_json(j)::text AS serialized FROM runtime_box_workbench_jobs j WHERE id=$1`, [success.id]);
    expect(raw.keys).toContain('SECRET_TOKEN');
    expect(raw.serialized).not.toContain('never-persist-me');
  }, 30_000);
});
