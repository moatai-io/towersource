import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The real adapter spawns a Task/Session/AI. This E2E verifies the DB-backed
// orchestrator only; it must never perform an external model call.
vi.mock('./adapters/legacy-task-execution-adapter.js', () => ({ executeWithLegacyTaskAdapter: vi.fn() }));
import { executeWithLegacyTaskAdapter } from './adapters/legacy-task-execution-adapter.js';

const runFile = promisify(execFile);
const run = process.env.EXECUTION_CONTROL_PLANE_PG_E2E === '1' ? describe : describe.skip;
async function docker(...args: string[]) { return runFile('docker', args, { maxBuffer: 4_000_000 }); }

run('Execution Control Plane disposable PostgreSQL E2E', () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const pgName = `tower-execution-pg-${suffix}`;
  let databaseUrl = '';
  let modules: any;
  let previousDatabaseUrl: string | undefined;

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    await docker('run', '-d', '--rm', '--name', pgName,
      '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=tower_execution_test',
      '-p', '127.0.0.1::5432', 'postgres:16-alpine');
    const mapped = await docker('port', pgName, '5432/tcp');
    const port = Number(mapped.stdout.trim().match(/:(\d+)$/)?.[1]);
    databaseUrl = `postgresql://postgres:test@127.0.0.1:${port}/tower_execution_test`;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { await runFile('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1']); break; }
      catch { if (attempt === 39) throw new Error('Disposable PostgreSQL did not become ready'); await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    process.env.DATABASE_URL = databaseUrl;
    const migrations = path.resolve(process.cwd(), 'packages/backend/db/migrations');
    // AI dispatch validates the canonical Project cwd via getProject(), whose
    // query also joins spaces and the Primary Agent profile (including career).
    // Include those real schema dependencies instead of mocking Project access.
    const fixtureMigrations = [
      '007_users.sql',
      '008_sessions.sql',
      '009_projects.sql',
      '010_remaining.sql',
      '015_task_todo_snapshot.sql',
      '017_spaces.sql',
      '024_schedules.sql',
      '026_automations.sql',
      '076_schedule_job_registry.sql',
      '099_process_maps.sql',
      '107_project_agent_profiles.sql',
      '113_agent_career.sql',
      '221_execution_control_plane_phase_1.sql',
      '222_execution_control_plane_phase_1_indexes.sql',
    ];
    for (const file of fixtureMigrations) {
      await runFile('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', path.join(migrations, file)]);
    }
    modules = {
      db: await import('../../db/pg-repo.js'),
      pg: await import('../../db/pg.js'),
      executions: await import('./execution-manager.js'),
      automationAdmission: await import('./automation-execution-admission.js'),
      occurrenceLookup: await import('./scheduled-occurrence-lookup.js'),
      projection: await import('./automation-execution-projection.js'),
      orchestrator: await import('./automation-execution-orchestrator.js'),
    };
    await modules.db.execute("INSERT INTO users(id,username,password_hash,role) VALUES(7,'execution-e2e','x','operator')");
    await modules.db.execute("INSERT INTO projects(id,name,root_path,user_id) VALUES('project-e2e','Execution E2E','/tmp/execution-e2e',7)");
  }, 120_000);

  afterAll(async () => {
    await modules?.pg?.closePgPool?.().catch(() => undefined);
    await docker('rm', '-f', '-v', pgName).catch(() => undefined);
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }, 120_000);

  it('enforces project/system scope constraints in PostgreSQL', async () => {
    await expect(modules.db.execute(`INSERT INTO executions (
      id,source_kind,scope_kind,project_id,actor_user_id,status,adapter_kind,idempotency_key
    ) VALUES ('invalid-system','system','system','project-e2e',7,'admitted','system','invalid-system')`)).rejects.toThrow();
    await expect(modules.db.execute(`INSERT INTO executions (
      id,source_kind,scope_kind,project_id,actor_user_id,status,adapter_kind,idempotency_key
    ) VALUES ('invalid-project','system','project',NULL,7,'admitted','system','invalid-project')`)).rejects.toThrow();
  });

  it('converges concurrent admission on one durable execution', async () => {
    const input = {
      sourceKind: 'automation' as const, sourceId: 'automation-e2e', scopeKind: 'project' as const,
      projectId: 'project-e2e', actorUserId: 7, adapterKind: 'legacy_task' as const,
      idempotencyKey: 'automation:automation-e2e:manual:command-1',
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => modules.executions.admitExecution(input)));
    expect(new Set(results.map((result: any) => result.execution.id)).size).toBe(1);
    const count = await modules.db.queryOne('SELECT COUNT(*)::int AS count FROM executions WHERE idempotency_key=$1', [input.idempotencyKey]);
    expect(count.count).toBe(1);
  });

  it('finds the exact scheduled occurrence and reuses one linked Run on replay', async () => {
    const dueAt = '2026-09-22T09:00:00.000Z';
    const automationId = 'scheduled-automation-e2e';
    await modules.db.execute(`INSERT INTO automations (id, user_id, project_id, name, job_type, mode, trigger_type, next_run_at)
      VALUES ($1, 7, 'project-e2e', 'Scheduled E2E', 'ai_prompt', 'spawn', 'cron', $2)`, [automationId, dueAt]);
    const automation = {
      id: automationId, userId: 7, projectId: 'project-e2e', scopeType: 'project',
      jobType: 'ai_prompt', mode: 'spawn', model: 'test-model',
    } as any;
    const input = {
      automation, trigger: 'schedule' as const, dueAt,
      idempotencyKey: `automation:${automationId}:schedule:${dueAt}`, adapterKind: 'legacy_task' as const,
    };
    expect(await modules.occurrenceLookup.hasScheduledAutomationExecution(automationId, dueAt)).toBe(false);
    const admissions = await Promise.all(Array.from({ length: 8 }, () => modules.automationAdmission.admitAutomationExecution(input)));
    const first = admissions.find((admission: any) => admission.created);
    expect(admissions.filter((admission: any) => admission.created)).toHaveLength(1);
    expect(new Set(admissions.map((admission: any) => admission.automationRunId)).size).toBe(1);
    expect(await modules.occurrenceLookup.hasScheduledAutomationExecution(automationId, dueAt)).toBe(true);
    expect(await modules.occurrenceLookup.hasScheduledAutomationExecution(automationId, '2026-09-23T09:00:00.000Z')).toBe(false);
    const replays = await Promise.all(Array.from({ length: 4 }, () => modules.automationAdmission.admitAutomationExecution(input)));
    for (const replay of replays) {
      expect(replay).toMatchObject({ created: false, automationRunId: first.automationRunId });
      expect(replay.execution.id).toBe(first.execution.id);
    }
    const rows = await modules.db.queryOne(`SELECT COUNT(*)::int AS runs, COUNT(DISTINCT e.id)::int AS executions
      FROM automation_runs r JOIN executions e ON e.id = r.execution_id WHERE e.idempotency_key = $1`, [input.idempotencyKey]);
    expect(rows).toEqual({ runs: 1, executions: 1 });
    const linked = await modules.db.queryOne('SELECT source_run_id FROM executions WHERE id = $1', [first.execution.id]);
    expect(linked.source_run_id).toBe(first.automationRunId);
    await modules.executions.transitionExecution({
      executionId: first.execution.id, expectedStatuses: ['admitted'], toStatus: 'running', eventType: 'execution_started',
    });
    const runningReplay = await modules.automationAdmission.admitAutomationExecution(input);
    expect(runningReplay).toMatchObject({ created: false, automationRunId: first.automationRunId, execution: { status: 'running' } });
    await modules.executions.transitionExecution({
      executionId: first.execution.id, expectedStatuses: ['running'], toStatus: 'succeeded', eventType: 'execution_completed',
    });
    const terminalReplay = await modules.automationAdmission.admitAutomationExecution(input);
    expect(terminalReplay).toMatchObject({ created: false, automationRunId: first.automationRunId, execution: { status: 'succeeded' } });
    const runCount = await modules.db.queryOne('SELECT COUNT(*)::int AS count FROM automation_runs WHERE execution_id = $1', [first.execution.id]);
    expect(runCount.count).toBe(1);
  });

  it('requires a persisted Run projection before treating a terminal Execution as replayable', async () => {
    const automationId = 'projection-barrier-e2e';
    await modules.db.execute(`INSERT INTO automations (id, user_id, project_id, name, job_type, mode, trigger_type)
      VALUES ($1, 7, 'project-e2e', 'Projection barrier E2E', 'ai_prompt', 'spawn', 'manual')`, [automationId]);
    const admission = await modules.automationAdmission.admitAutomationExecution({
      automation: { id: automationId, userId: 7, projectId: 'project-e2e', scopeType: 'project', jobType: 'ai_prompt', mode: 'spawn', model: 'test-model' } as any,
      trigger: 'manual', idempotencyKey: `automation:${automationId}:manual:test`, adapterKind: 'legacy_task',
    });
    const terminal = await modules.executions.transitionExecution({
      executionId: admission.execution.id, expectedStatuses: ['admitted'], toStatus: 'succeeded', eventType: 'execution_succeeded',
    });
    await expect(modules.projection.assertAutomationRunProjected(admission.automationRunId, terminal.id, terminal.status))
      .rejects.toThrow('projection incomplete');
    await expect(modules.projection.projectAutomationExecutionResult({
      automationRunId: 'wrong-run', execution: terminal,
      receipt: { outcome: 'succeeded', taskId: 'test-task', sessionId: null, executorRef: 'task:test-task', errorJson: null },
      durationMs: 0, startedAt: '2026-09-22T09:00:00Z', finishedAt: '2026-09-22T09:00:01Z', executionPath: 'execution_control_plane',
    })).rejects.toThrow('projection not written');
    await modules.projection.projectAutomationExecutionResult({
      automationRunId: admission.automationRunId, execution: terminal,
      receipt: { outcome: 'succeeded', taskId: 'test-task', sessionId: null, executorRef: 'task:test-task', errorJson: null },
      durationMs: 1000, startedAt: '2026-09-22T09:00:00Z', finishedAt: '2026-09-22T09:00:01Z', executionPath: 'execution_control_plane',
    });
    await expect(modules.projection.assertAutomationRunProjected(admission.automationRunId, terminal.id, terminal.status))
      .resolves.toBeUndefined();
  });

  it.each(['manual', 'schedule'] as const)('runs one %s occurrence through the DB-backed orchestrator without AI', async trigger => {
    const automationId = `orchestrator-${trigger}-e2e`;
    const dueAt = trigger === 'schedule' ? '2026-09-22T09:00:00.000Z' : null;
    const idempotencyKey = trigger === 'schedule'
      ? `automation:${automationId}:schedule:${dueAt}`
      : `automation:${automationId}:manual:test-command`;
    await modules.db.execute(`INSERT INTO automations (id, user_id, project_id, name, job_type, mode, trigger_type, next_run_at)
      VALUES ($1, 7, 'project-e2e', 'Orchestrator E2E', 'ai_prompt', 'spawn', $2, $3)`, [automationId, trigger, dueAt]);
    const automation = {
      id: automationId, userId: 7, projectId: 'project-e2e', scopeType: 'project', name: 'Orchestrator E2E',
      prompt: 'synthetic test only', definitionJson: {}, jobType: 'ai_prompt', mode: 'spawn', model: 'test-model',
    } as any;
    vi.mocked(executeWithLegacyTaskAdapter).mockClear();
    vi.mocked(executeWithLegacyTaskAdapter).mockResolvedValueOnce({
      adapterKind: 'legacy_task', outcome: 'succeeded', executorRef: `task:${automationId}`,
      taskId: `task-${automationId}`, sessionId: null, summaryText: 'synthetic completed',
      resultJson: { taskId: `task-${automationId}` }, errorJson: null,
    });
    const input = { automation, trigger, dueAt, idempotencyKey, broadcast: vi.fn() };
    const first = await modules.orchestrator.executeAutomationViaExecutionControlPlane(input);
    expect(first).toMatchObject({ executionStatus: 'succeeded', replayedOccurrence: false, result: { status: 'success' } });
    expect(executeWithLegacyTaskAdapter).toHaveBeenCalledTimes(1);
    const replay = await modules.orchestrator.executeAutomationViaExecutionControlPlane(input);
    expect(replay).toMatchObject({ executionId: first.executionId, automationRunId: first.automationRunId, replayedOccurrence: true });
    expect(executeWithLegacyTaskAdapter).toHaveBeenCalledTimes(1);
    const row = await modules.db.queryOne(`SELECT e.status AS execution_status, e.input_json ->> 'trigger' AS trigger,
      e.input_json ->> 'dueAt' AS due_at, ar.status AS run_status, ar.finished_at AS finished_at,
      e.session_id, (SELECT COUNT(*)::int FROM execution_events ev WHERE ev.execution_id = e.id) AS event_count
      FROM executions e JOIN automation_runs ar ON ar.execution_id = e.id WHERE e.idempotency_key = $1`, [idempotencyKey]);
    expect(row).toMatchObject({ execution_status: 'succeeded', trigger, due_at: dueAt, run_status: 'success', session_id: null, event_count: 3 });
    expect(row.finished_at).not.toBeNull();
    expect(await modules.db.queryOne('SELECT COUNT(*)::int AS count FROM automation_runs WHERE execution_id = $1', [first.executionId]))
      .toEqual({ count: 1 });
  });

  it('commits a state transition and event together', async () => {
    const admitted = await modules.executions.admitExecution({
      sourceKind: 'manual', sourceId: 'manual-e2e', scopeKind: 'system', actorUserId: 7,
      adapterKind: 'system', idempotencyKey: 'manual:e2e:transition',
    });
    await modules.executions.transitionExecution({
      executionId: admitted.execution.id, expectedStatuses: ['admitted'], toStatus: 'running', eventType: 'execution_started',
    });
    const row = await modules.db.queryOne(`SELECT e.status, COUNT(ev.id)::int AS event_count
      FROM executions e JOIN execution_events ev ON ev.execution_id=e.id WHERE e.id=$1 GROUP BY e.status`, [admitted.execution.id]);
    expect(row).toEqual({ status: 'running', event_count: 2 });
  });
});
