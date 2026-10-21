import {createReviewedGoalStore} from './reviewed-goal-store';
import { issueManagedCodeReceipt } from './managed-code-receipt';
import { digestCodeManifest } from './bounded-code-check';
import * as testFs from 'node:fs/promises';
import testPath from 'node:path';
import { createManagedGoalEvidenceVerifier } from './managed-goal-evidence';
import { criterionHash } from './goal-evidence';
import { createManagedGoalTerminalObserver } from './managed-goal-terminal';
import { createManagedGoalStart } from './managed-goal-start';
import { createManagedGoalGuard } from './managed-goal-guard';
import { createManagedGoalService } from './managed-goal-service';
import { createGoalServiceTools } from './goal-tools';
import { claimExecutionRecovery } from './execution-recovery-claim';
import { inspectExecutionRecovery } from './execution-recovery-safety';
import { beginSideEffectExecution, finishSideEffectExecution } from '../agent-turn/side-effect-ledger';
import { claimAgentTurn, claimForegroundAgentTurn, settleAgentTurn } from '../agent-turn/turn-supervisor';
import { registerInternalGoalTurn } from './goal-turn-registration';
import { createGoalStop } from './goal-stop';
import { acquireSessionAdmissionLock } from '../agent-turn/session-admission-lock';
import { createGoalInternalRequestGateway } from './goal-internal-request';
import { createGoalDispatchSafety } from './goal-dispatch-safety';
import { createGoalIntentConsumer } from './goal-intent-consumer';
import { createPostgresGoalManagerStore } from './goal-manager-store';
import { createGoalManager, type ManagedGoal } from './goal-manager';
import { startGoal } from './goal-loop';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createGoalSession } from './goal-session';
import { createPostgresGoalStore } from './goal-store';
import { createTransactionalGoalGuard } from './goal-guard';
const exec = promisify(execFile);
const suite = process.env.GOAL_PG_E2E === '1' ? describe : describe.skip;
suite('goal isolated PostgreSQL integration', () => {
  const name = `tower-goal-test-${randomUUID().slice(0, 8)}`;
  let started = false;
  let db: typeof import('../../db/pg-repo.js');
  let pg: typeof import('../../db/pg.js');
  let original: string | undefined;
  const docker = (...args: string[]) => exec('docker', args, { timeout: 20000, maxBuffer: 100000 });
  beforeAll(async () => {
    original = process.env.DATABASE_URL;
    await docker('run', '-d', '--rm', '--pull=never', '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=goal_test', '-p', '127.0.0.1::5432', 'postgres:16-alpine');
    started = true;
    const port = Number((await docker('port', name, '5432/tcp')).stdout.trim().split(':').at(-1));
    if (!Number.isInteger(port) || port <= 0) throw new Error('INVALID_TEST_PORT');
    process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${port}/goal_test`;
    db = await import('../../db/pg-repo.js'); pg = await import('../../db/pg.js');
    for (let i = 0; i < 40; i++) {
      try { await db.query('SELECT 1'); break; } catch { if (i === 39) throw new Error('TEST_DB_UNAVAILABLE'); await new Promise(r => setTimeout(r, 250)); }
    }
    for (const file of ['007_users.sql', '008_sessions.sql', '009_projects.sql', '138_agent_turns.sql', '139_agent_turn_owner_boot.sql', '146_agent_turn_timing_lifecycle.sql', '137_side_effect_execution_ledger.sql']) {
      await db.query(await readFile(`packages/backend/db/migrations/${file}`, 'utf8'));
    }
    await db.query(await readFile('packages/backend/services/goal-loop/schema.sql', 'utf8'));
    await db.query(await readFile('packages/backend/services/goal-loop/goal-manager-schema.sql', 'utf8'));
    await db.query(await readFile('packages/backend/services/goal-loop/reviewed-goal-store.sql','utf8'));
    await db.query('CREATE TABLE fixture_goal_queue(intent_key text PRIMARY KEY, root_id text UNIQUE NOT NULL)');
    await db.query("INSERT INTO users(id,username,password_hash) VALUES(1,'fixture-user','not-a-login'); INSERT INTO projects(id,name,user_id) VALUES('p','fixture',1)");
  }, 60000);
  afterAll(async () => {
    try { await pg?.closePgPool(); } finally {
      if (started) await docker('rm', '-f', '-v', name);
      if (original === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = original;
    }
  }, 25000);
  async function fixture() {
    const id = randomUUID();
    const scope = { userId: 1, projectId: 'p', sessionId: id, rootTurnId: `r-${id}` };
    await db.query("INSERT INTO sessions(id,name,user_id,project_id) VALUES($1,'fixture',1,'p')", [id]);
    await db.query("INSERT INTO messages(id,session_id,role,content) VALUES($1,$2,'user','fixture')", [scope.rootTurnId, id]);
    await db.query("INSERT INTO agent_turns(root_turn_id,session_id,state,owner_token,owner_boot_id,lease_until) VALUES($1,$2,'running','fixture-token','fixture-boot',NOW()+interval '10 minutes')", [scope.rootTurnId, id]);
    const guard = createTransactionalGoalGuard({ ownerToken: 'fixture-token', ownerBootId: 'fixture-boot', goalAuthorized: true, trustedVerifierIds: new Set(), evidenceSnapshot: async () => null });
    const store = createPostgresGoalStore(guard);
    const session = createGoalSession(scope, store);
    const start = { requestId: 'start', expectedVersion: 0, command: { action: 'start', goal: 'fixture', criteria: [{ id: 'a', description: 'passes' }] } };
    return { scope, store, session, start };
  }
  it('persists and deduplicates concurrent first requests', async () => {
    const f = await fixture();
    const results = await Promise.all([f.session.execute(f.start), f.session.execute(f.start)]);
    expect(results[0]).toEqual(results[1]);
    expect((await createGoalSession(f.scope, f.store).status())?.version).toBe(1);
  });
  it('serializes competing updates and rejects stale version', async () => {
    const f = await fixture(); await f.session.execute(f.start);
    const requests = ['a','b'].map(requestId => f.session.execute({ requestId, expectedVersion: 1, command: { action: 'inspect', decision: 'change', reason: 'fix' } }));
    const results = await Promise.allSettled(requests);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await f.session.status())?.version).toBe(2);
  });
  it.each(['owner', 'wait', 'newer'])('rejects %s and leaves no goal row', async mode => {
    const f = await fixture();
    if (mode === 'owner') await db.query("UPDATE agent_turns SET owner_token='other' WHERE root_turn_id=$1", [f.scope.rootTurnId]);
    if (mode === 'wait') await db.query('UPDATE agent_turns SET waiting_user_started_at=NOW() WHERE root_turn_id=$1', [f.scope.rootTurnId]);
    if (mode === 'newer') await db.query("INSERT INTO messages(id,session_id,role,content,created_at) VALUES($1,$2,'user','new',NOW()+interval '1 second')", [randomUUID(), f.scope.sessionId]);
    await expect(f.session.execute(f.start)).rejects.toThrow('GOAL_TRANSACTION_GUARD_DENIED');
    expect(await f.session.status()).toBeNull();
  });
  it('does not change timestamp on status', async () => {
    const f = await fixture(); await f.session.execute(f.start);
    const before = await db.query('SELECT updated_at FROM goal_sessions WHERE root_turn_id=$1', [f.scope.rootTurnId]);
    await f.session.status();
    expect(await db.query('SELECT updated_at FROM goal_sessions WHERE root_turn_id=$1', [f.scope.rootTurnId])).toEqual(before);
  });
  it('cannot complete with unverified receipt and rolls back the version', async () => {
    const f = await fixture(); await f.session.execute(f.start);
    await f.session.execute({ requestId: 'i', expectedVersion: 1, command: { action: 'inspect', decision: 'verify', reason: 'verify' } });
    await expect(f.session.execute({ requestId: 'k', expectedVersion: 2, command: { action: 'check', outcome: 'improved', evidence: [{ criterionId: 'a', revision: 'initial', reference: 'fake', passed: true }] } })).rejects.toThrow('GOAL_TRANSACTION_GUARD_DENIED');
    expect((await f.session.status())?.version).toBe(2);
  });
  async function managerFixture() {
    const id = randomUUID();
    const goal: ManagedGoal = { id, userId: 1, projectId: 'p', sessionId: 's', version: 1,
      state: startGoal('fix', [{ id: 'a', description: 'passes' }]),
      activeExecution: { rootTurnId: 'root', startProgressVersion: 1 }, progressVersion: 2,
      dispatched: 1, maxExecutions: 5, processedTerminalIds: [] };
    await db.query('INSERT INTO managed_goals(id, record) VALUES($1,$2::jsonb)', [id, JSON.stringify(goal)]);
    // Observer is a fixture, NOT a production ACL/receipt verifier.
    const store = createPostgresGoalManagerStore({ observe: async () => ({
      terminal: { id: 'terminal', rootTurnId: 'root', outcome: 'completed' },
      authorized: true, userStopped: false, waitingApproval: false, superseded: false,
      uncertainEffects: false, completionVerified: false,
    }) });
    return { id, goal, manager: createGoalManager(store) };
  }
  it('atomically deduplicates concurrent goal terminal deliveries', async () => {
    const f = await managerFixture();
    const results = await Promise.all([f.manager.onTerminal(f.id, 'terminal'), f.manager.onTerminal(f.id, 'terminal')]);
    expect(results.filter(r => r.kind === 'settle')).toHaveLength(1);
    expect(results.filter(r => r.kind === 'ignore')).toHaveLength(1);
    expect(await db.query('SELECT intent_key FROM goal_dispatch_intents WHERE goal_id=$1', [f.id])).toHaveLength(1);
    const rows = await db.query<{record: ManagedGoal}>('SELECT record FROM managed_goals WHERE id=$1', [f.id]);
    expect(rows[0].record.version).toBe(2);
    expect(rows[0].record.processedTerminalIds).toEqual(['terminal']);
  });
  it('rolls back goal update and cancellation if intent insertion fails', async () => {
    const f = await managerFixture();
    await db.query(`INSERT INTO goal_dispatch_intents(intent_key,goal_id,expected_goal_version,payload,state)
      VALUES($1,$2,2,'{}','cancelled')`, [`goal:${f.id}:version:2`, f.id]);
    await expect(f.manager.onTerminal(f.id, 'terminal')).rejects.toThrow();
    const rows = await db.query<{record: ManagedGoal}>('SELECT record FROM managed_goals WHERE id=$1', [f.id]);
    expect(rows[0].record).toEqual(f.goal);
    expect(await db.query("SELECT intent_key FROM goal_dispatch_intents WHERE goal_id=$1 AND state='pending'", [f.id])).toHaveLength(0);
  });

  async function intentFixture() {
    const f = await managerFixture();
    const settlement = await f.manager.onTerminal(f.id, 'terminal');
    if (settlement.kind !== 'settle' || !settlement.intent) throw new Error('fixture intent missing');
    return { ...f, key: settlement.intent.key };
  }
  const testEnqueue = async (client: import('pg').PoolClient, _goal: Readonly<ManagedGoal>, intent: { key: string }) => {
    const root = randomUUID();
    await client.query('INSERT INTO fixture_goal_queue(intent_key,root_id) VALUES($1,$2)', [intent.key, root]);
    return root;
  };
  it('admits concurrent consumers once and reconciles retry without a second queue entry', async () => {
    const f = await intentFixture();
    const consumer = createGoalIntentConsumer({ check: async () => 'ready', enqueue: testEnqueue });
    const results = await Promise.all([consumer.consume(f.id, f.key), consumer.consume(f.id, f.key)]);
    expect(results.map(r => r.status).sort()).toEqual(['admitted', 'already_admitted']);
    expect(await db.query('SELECT * FROM fixture_goal_queue WHERE intent_key=$1', [f.key])).toHaveLength(1);
    const rows = await db.query<{record: ManagedGoal}>('SELECT record FROM managed_goals WHERE id=$1', [f.id]);
    expect(rows[0].record.dispatched).toBe(2);
    expect(rows[0].record.id).toBe(f.id);
    expect(rows[0].record.activeExecution?.rootTurnId).not.toBe('root');
  });
  it.each(['busy', 'denied'] as const)('rechecks %s before enqueue', async gate => {
    const f = await intentFixture();
    const consumer = createGoalIntentConsumer({ check: async () => gate, enqueue: testEnqueue });
    expect((await consumer.consume(f.id, f.key)).status).toBe(gate === 'busy' ? 'busy' : 'cancelled');
    expect(await db.query('SELECT * FROM fixture_goal_queue WHERE intent_key=$1', [f.key])).toHaveLength(0);
  });
  it('rolls back partially persisted enqueue on gateway failure', async () => {
    const f = await intentFixture();
    const consumer = createGoalIntentConsumer({ check: async () => 'ready', enqueue: async (...args) => {
      await testEnqueue(...args); throw new Error('fixture failure');
    } });
    await expect(consumer.consume(f.id, f.key)).rejects.toThrow('fixture failure');
    expect(await db.query('SELECT * FROM fixture_goal_queue WHERE intent_key=$1', [f.key])).toHaveLength(0);
    const intents = await db.query<{state:string}>('SELECT state FROM goal_dispatch_intents WHERE intent_key=$1', [f.key]);
    expect(intents[0].state).toBe('pending');
  });
  it('cancels stale goal intent without dispatching', async () => {
    const f = await intentFixture();
    await db.query("UPDATE managed_goals SET record=jsonb_set(record,'{version}','99') WHERE id=$1", [f.id]);
    const consumer = createGoalIntentConsumer({ check: async () => 'ready', enqueue: testEnqueue });
    expect((await consumer.consume(f.id, f.key)).status).toBe('cancelled');
    expect(await db.query('SELECT * FROM fixture_goal_queue WHERE intent_key=$1', [f.key])).toHaveLength(0);
  });

  it.each(['ready', 'busy', 'newer', 'anchor', 'archived', 'wait', 'scope'] as const)('checks real dispatch safety: %s', async mode => {
    const f = await fixture();
    await db.query("UPDATE agent_turns SET state='completed', owner_token=NULL WHERE root_turn_id=$1", [f.scope.rootTurnId]);
    const g = (await managerFixture()).goal;
    g.sessionId = f.scope.sessionId;
    const check = createGoalDispatchSafety({ goalId: g.id, userId: 1, projectId: 'p', sessionId: f.scope.sessionId,
      userMessageId: mode === 'anchor' ? 'missing' : f.scope.rootTurnId });
    if (mode === 'busy') await db.query("UPDATE agent_turns SET state='running' WHERE root_turn_id=$1", [f.scope.rootTurnId]);
    if (mode === 'newer') await db.query("INSERT INTO messages(id,session_id,role,content,created_at) VALUES($1,$2,'user','new input',NOW()+interval '1 second')", [randomUUID(), f.scope.sessionId]);
    if (mode === 'archived') await db.query('UPDATE sessions SET archived=1 WHERE id=$1', [f.scope.sessionId]);
    if (mode === 'wait') await db.query('UPDATE agent_turns SET waiting_user_started_at=NOW() WHERE root_turn_id=$1', [f.scope.rootTurnId]);
    if (mode === 'scope') g.userId = 999;
    expect(await db.transaction(client => check(client, g))).toBe(mode === 'ready' ? 'ready' : mode === 'busy' ? 'busy' : 'denied');
  });

  it('persists real internal provenance without writing a user message or retry turn', async () => {
    const f = await fixture();
    await db.query("UPDATE agent_turns SET state='completed',owner_token=NULL WHERE root_turn_id=$1", [f.scope.rootTurnId]);
    const m = await managerFixture();
    m.goal.sessionId = f.scope.sessionId;
    await db.query('UPDATE managed_goals SET record=$2::jsonb WHERE id=$1', [m.id, JSON.stringify(m.goal)]);
    const result = await m.manager.onTerminal(m.id, 'terminal');
    if(result.kind !== 'settle' || !result.intent) throw new Error('missing intent');
    const messagesBefore = await db.query('SELECT id FROM messages WHERE session_id=$1', [f.scope.sessionId]);
    const turnsBefore = await db.query('SELECT root_turn_id FROM agent_turns WHERE session_id=$1', [f.scope.sessionId]);
    const gateway = createGoalInternalRequestGateway({goalId:m.id,userId:1,projectId:'p',sessionId:f.scope.sessionId,userMessageId:f.scope.rootTurnId});
    const intent = result.intent;
    expect((await db.transaction(client => gateway.persist(client, result.goal, intent))).status).toBe('persisted');
    const storedGoals = await db.query<{record:ManagedGoal}>('SELECT record FROM managed_goals WHERE id=$1', [m.id]);
    expect(storedGoals[0].record.activeExecution).toBeNull();
    expect(storedGoals[0].record.dispatched).toBe(1);
    expect((await db.query<{state:string}>('SELECT state FROM goal_dispatch_intents WHERE intent_key=$1', [intent.key]))[0].state).toBe('pending');
    const requests = await db.query<{source_user_message_id:string}>('SELECT * FROM goal_internal_requests WHERE goal_id=$1', [m.id]);
    expect(requests).toHaveLength(1);
    expect(requests[0].source_user_message_id).toBe(f.scope.rootTurnId);
    expect(await db.query('SELECT id FROM messages WHERE session_id=$1', [f.scope.sessionId])).toEqual(messagesBefore);
    expect(await db.query('SELECT root_turn_id FROM agent_turns WHERE session_id=$1', [f.scope.sessionId])).toEqual(turnsBefore);
  });

  it('backfills legacy roots additively and preserves turn rows', async () => {
    await fixture();
    await db.transaction(async client => {
      const before = await client.query('SELECT * FROM agent_turns ORDER BY root_turn_id');
      await client.query(await readFile('packages/backend/services/goal-loop/execution-request-draft.sql', 'utf8'));
      const missing = await client.query(`SELECT a.root_turn_id FROM agent_turns a
        LEFT JOIN execution_requests_draft r ON r.id=a.root_turn_id AND r.session_id=a.session_id
        WHERE r.id IS NULL`);
      expect(missing.rowCount).toBe(0);
      expect((await client.query('SELECT * FROM agent_turns ORDER BY root_turn_id')).rows).toEqual(before.rows);
      // Test-local cleanup inside the isolated DB, not a production migration.
      await client.query('DROP TABLE execution_requests_draft');
    });
  });
  it('rejects cross-session legacy roots instead of misattributing execution', async () => {
    const a = await fixture(); const b = await fixture();
    await expect(db.transaction(async client => {
      await client.query('UPDATE agent_turns SET session_id=$2 WHERE root_turn_id=$1', [a.scope.rootTurnId,b.scope.sessionId]);
      await client.query(await readFile('packages/backend/services/goal-loop/execution-request-draft.sql', 'utf8'));
    })).rejects.toThrow('EXECUTION_BACKFILL_UNRESOLVED_ROOT');
    expect((await db.query<{session_id:string}>('SELECT session_id FROM agent_turns WHERE root_turn_id=$1',[a.scope.rootTurnId]))[0].session_id).toBe(a.scope.sessionId);
  });

  it('rejects non-user legacy anchors and rolls back the entire draft schema', async () => {
    const f = await fixture();
    await expect(db.transaction(async client => {
      await client.query("UPDATE messages SET role='assistant' WHERE id=$1", [f.scope.rootTurnId]);
      await client.query(await readFile('packages/backend/services/goal-loop/execution-request-draft.sql', 'utf8'));
    })).rejects.toThrow('EXECUTION_BACKFILL_UNRESOLVED_ROOT');
    expect((await db.query<{relation:string|null}>("SELECT to_regclass('execution_requests_draft')::text AS relation"))[0].relation).toBeNull();
    expect((await db.query<{role:string}>('SELECT role FROM messages WHERE id=$1',[f.scope.rootTurnId]))[0].role).toBe('user');
  });

  it('waits behind shared chat admission and checks safety after release', async () => {
    const f = await intentFixture();
    const release = await acquireSessionAdmissionLock('s');
    let checked = false;
    let deny = false;
    const consumer = createGoalIntentConsumer({ check: async () => { checked = true; return deny ? 'denied' : 'ready'; }, enqueue: testEnqueue });
    let done = false;
    const pending = consumer.consume(f.id, f.key).finally(() => { done = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(checked).toBe(false); expect(done).toBe(false);
      deny = true;
    } finally { release(); }
    expect((await pending).status).toBe('cancelled');
    expect(checked).toBe(true);
    expect(await db.query('SELECT * FROM fixture_goal_queue WHERE intent_key=$1',[f.key])).toHaveLength(0);
  });

  it('persisted stop cancels pending intent and blocks subsequent consumption', async () => {
    const f = await fixture(); const m = await managerFixture();
    m.goal.sessionId=f.scope.sessionId;
    await db.query('UPDATE managed_goals SET record=$2::jsonb WHERE id=$1',[m.id,JSON.stringify(m.goal)]);
    const settled=await m.manager.onTerminal(m.id,'terminal');
    if(settled.kind!=='settle'||!settled.intent) throw new Error('fixture');
    const stop=createGoalStop({userId:1,projectId:'p',sessionId:f.scope.sessionId});
    expect(await stop(m.id)).toMatchObject({status:'stopped',activeExecutionCancellationRequired:false});
    const consumer=createGoalIntentConsumer({check:async()=> 'ready',enqueue:testEnqueue});
    expect((await consumer.consume(m.id,settled.intent.key)).status).toBe('cancelled');
    const before=await db.query('SELECT record FROM managed_goals WHERE id=$1',[m.id]);
    await stop(m.id);
    expect(await db.query('SELECT record FROM managed_goals WHERE id=$1',[m.id])).toEqual(before);
  });
  it('stop preserves active execution identity and rejects wrong owner', async () => {
    const f=await fixture(); const m=await managerFixture();m.goal.sessionId=f.scope.sessionId;
    await db.query('UPDATE managed_goals SET record=$2::jsonb WHERE id=$1',[m.id,JSON.stringify(m.goal)]);
    await expect(createGoalStop({userId:999,projectId:'p',sessionId:f.scope.sessionId})(m.id)).rejects.toThrow('GOAL_STOP_DENIED');
    expect(await createGoalStop({userId:1,projectId:'p',sessionId:f.scope.sessionId})(m.id)).toMatchObject({status:'stopped',activeRootTurnId:'root',activeExecutionCancellationRequired:true});
    const result=await m.manager.onTerminal(m.id,'terminal');
    expect(result).toMatchObject({kind:'settle',reason:'user_stopped'});
    expect(result).not.toHaveProperty('intent');
  });

  it('serializes stop versus admission without losing the admitted root', async () => {
    const f=await fixture(); const m=await managerFixture();m.goal.sessionId=f.scope.sessionId;
    await db.query('UPDATE managed_goals SET record=$2::jsonb WHERE id=$1',[m.id,JSON.stringify(m.goal)]);
    const settled=await m.manager.onTerminal(m.id,'terminal');
    if(settled.kind!=='settle'||!settled.intent) throw new Error('fixture');
    const stop=createGoalStop({userId:1,projectId:'p',sessionId:f.scope.sessionId});
    const consumer=createGoalIntentConsumer({check:async()=> 'ready',enqueue:testEnqueue});
    const [stopped, consumed]=await Promise.all([stop(m.id),consumer.consume(m.id,settled.intent.key)]);
    const record=(await db.query<{record:ManagedGoal}>('SELECT record FROM managed_goals WHERE id=$1',[m.id]))[0].record;
    expect(record.state.status).toBe('stopped');
    const queued=await db.query<{root_id:string}>('SELECT root_id FROM fixture_goal_queue WHERE intent_key=$1',[settled.intent.key]);
    expect(queued.length).toBeLessThanOrEqual(1);
    if(queued.length) {
      expect(record.activeExecution?.rootTurnId).toBe(queued[0].root_id);
      expect(stopped.activeExecutionCancellationRequired).toBe(true);
      expect(consumed.status).toBe('admitted');
    } else {
      expect(consumed.status).toBe('cancelled');
      expect(record.activeExecution).toBeNull();
    }
  });

  it('registers an internal root against execution provenance after isolated FK cutover', async () => {
    const f=await fixture(); const m=await managerFixture();m.goal.sessionId=f.scope.sessionId;
    await db.query('UPDATE managed_goals SET record=$2::jsonb WHERE id=$1',[m.id,JSON.stringify(m.goal)]);
    await db.query("UPDATE agent_turns SET state='completed',owner_token=NULL WHERE root_turn_id=$1",[f.scope.rootTurnId]);
    const settled=await m.manager.onTerminal(m.id,'terminal');
    if(settled.kind!=='settle'||!settled.intent) throw new Error('fixture');
    const gateway=createGoalInternalRequestGateway({goalId:m.id,userId:1,projectId:'p',sessionId:f.scope.sessionId,userMessageId:f.scope.rootTurnId});
    const intent=settled.intent;
    await db.transaction(async client => {
      await client.query('SAVEPOINT isolated_cutover');
      await client.query(await readFile('packages/backend/services/goal-loop/execution-request-draft.sql','utf8'));
      await client.query('ALTER TABLE agent_turns DROP CONSTRAINT agent_turns_root_turn_id_fkey');
      await client.query('ALTER TABLE agent_turns ADD CONSTRAINT agent_turns_root_turn_id_fkey FOREIGN KEY(root_turn_id) REFERENCES execution_requests_draft(id)');
      await client.query('ALTER TABLE side_effect_executions DROP CONSTRAINT side_effect_executions_root_turn_id_fkey');
      await client.query('ALTER TABLE side_effect_executions ADD CONSTRAINT side_effect_executions_root_turn_id_fkey FOREIGN KEY(root_turn_id) REFERENCES execution_requests_draft(id)');
      const request=await gateway.persist(client,settled.goal,intent);
      await registerInternalGoalTurn(client,request.requestId);
      expect((await client.query('SELECT id FROM messages WHERE id=$1',[request.requestId])).rowCount).toBe(0);
      expect((await client.query('SELECT state FROM agent_turns WHERE root_turn_id=$1',[request.requestId])).rows[0].state).toBe('running');
      const transact: typeof db.transaction = async fn => fn(client);
      const effectInput = {rootTurnId:request.requestId,sessionId:f.scope.sessionId,toolName:'fixture',toolCallId:'call',semanticHash:'fixture-hash',recovering:false};
      const effect = await beginSideEffectExecution(effectInput,transact);
      expect(effect.kind).toBe('execute');
      expect((await beginSideEffectExecution(effectInput,transact)).kind).toBe('block');
      if(effect.kind !== 'execute') throw new Error('effect fixture');
      expect(await finishSideEffectExecution({executionId:effect.executionId,ownerToken:'wrong',result:{}},transact)).toBe(false);
      expect(await finishSideEffectExecution({executionId:effect.executionId,ownerToken:effect.ownerToken,result:{verified:true}},transact)).toBe(true);
      expect(await beginSideEffectExecution({...effectInput,toolCallId:'recovery-call',recovering:true},transact)).toEqual({kind:'reuse',result:{verified:true}});
      const readOne = db.withClient(client).queryOne;
      const claim = await claimForegroundAgentTurn({rootTurnId:request.requestId,sessionId:f.scope.sessionId,ownerBootId:'fixture-boot'},readOne);
      expect(claim.claimed).toBe(true);
      expect((await claimForegroundAgentTurn({rootTurnId:request.requestId,sessionId:f.scope.sessionId,ownerBootId:'other'},readOne)).claimed).toBe(false);
      expect(await settleAgentTurn({rootTurnId:request.requestId,token:'wrong',state:'completed'},readOne)).toBe(false);
      expect(await settleAgentTurn({rootTurnId:request.requestId,token:claim.token!,state:'completed'},readOne)).toBe(true);
      expect((await client.query('SELECT state,owner_token FROM agent_turns WHERE root_turn_id=$1',[request.requestId])).rows[0]).toEqual({state:'completed',owner_token:null});
      await client.query("UPDATE agent_turns SET state='waiting_retry' WHERE root_turn_id=$1",[request.requestId]);
      const recoveringGoal={...settled.goal,activeExecution:{rootTurnId:request.requestId,startProgressVersion:2}};
      await client.query('UPDATE managed_goals SET record=$2::jsonb WHERE id=$1',[m.id,JSON.stringify(recoveringGoal)]);
      expect(await inspectExecutionRecovery(client,request.requestId,f.scope.sessionId)).toBe('eligible');
      await client.query("UPDATE agent_turns SET owner_token='other' WHERE root_turn_id=$1",[request.requestId]);
      expect(await inspectExecutionRecovery(client,request.requestId,f.scope.sessionId)).toBe('busy');
      await client.query("UPDATE agent_turns SET owner_token=NULL WHERE root_turn_id=$1",[request.requestId]);
      await client.query("UPDATE managed_goals SET record=jsonb_set(record,'{state,status}','\"stopped\"') WHERE id=$1",[m.id]);
      expect(await inspectExecutionRecovery(client,request.requestId,f.scope.sessionId)).toBe('denied');
      await client.query('UPDATE managed_goals SET record=$2::jsonb WHERE id=$1',[m.id,JSON.stringify(recoveringGoal)]);
      await client.query("UPDATE agent_turns SET next_attempt_at=NOW()+interval '5 minutes' WHERE root_turn_id=$1",[request.requestId]);
      expect(await inspectExecutionRecovery(client,request.requestId,f.scope.sessionId)).toBe('busy');
      await client.query('UPDATE agent_turns SET next_attempt_at=NULL WHERE root_turn_id=$1',[request.requestId]);
      await client.query("UPDATE managed_goals SET record=jsonb_set(record,'{userId}','999') WHERE id=$1",[m.id]);
      expect(await inspectExecutionRecovery(client,request.requestId,f.scope.sessionId)).toBe('denied');
      await client.query('UPDATE managed_goals SET record=$2::jsonb WHERE id=$1',[m.id,JSON.stringify(recoveringGoal)]);
      const recovered=await claimExecutionRecovery(client,{requestId:request.requestId,sessionId:f.scope.sessionId,ownerBootId:'recovery-fixture'});
      expect(recovered.claimed).toBe(true);
      expect((await claimExecutionRecovery(client,{requestId:request.requestId,sessionId:f.scope.sessionId,ownerBootId:'second'})).claimed).toBe(false);
      await client.query("UPDATE agent_turns SET state='waiting_retry',owner_token=NULL WHERE root_turn_id=$1",[request.requestId]);
      // New input after source but BEFORE internal turn acceptance must supersede.
      await client.query("UPDATE messages SET created_at=NOW()-interval '2 minutes' WHERE id=$1",[f.scope.rootTurnId]);
      await client.query("INSERT INTO messages(id,session_id,role,content,created_at) VALUES($1,$2,'user','new instruction',NOW()-interval '1 minute')",[randomUUID(),f.scope.sessionId]);
      expect(await inspectExecutionRecovery(client,request.requestId,f.scope.sessionId)).toBe('denied');
      expect((await claimExecutionRecovery(client,{requestId:request.requestId,sessionId:f.scope.sessionId,ownerBootId:'blocked'})).claimed).toBe(false);
      // Restore every experimental schema/data change, including FK, in this test.
      await client.query('ROLLBACK TO SAVEPOINT isolated_cutover');
    });
  });

  it('does not recover another session root with a supplied wrong session', async () => {
    const a=await fixture(); const b=await fixture();
    await db.query("UPDATE agent_turns SET state='waiting_retry',owner_token=NULL WHERE root_turn_id=$1",[a.scope.rootTurnId]);
    const result=await claimAgentTurn({rootTurnId:a.scope.rootTurnId,sessionId:b.scope.sessionId,source:'fixture',ownerBootId:'fixture'});
    expect(result.claimed).toBe(false);
    const row=(await db.query<{state:string;attempt_count:number}>('SELECT state,attempt_count FROM agent_turns WHERE root_turn_id=$1',[a.scope.rootTurnId]))[0];
    expect(row).toEqual({state:'waiting_retry',attempt_count:0});
  });

  it('common tools update the manager goal across idempotent commands without resetting identity', async () => {
    const m=await managerFixture();
    const service=createManagedGoalService({goalId:m.id,userId:1,projectId:'p',sessionId:'s',rootTurnId:'root'},
      {validate:async(_c,_g,command)=>command?.action!=='check'});
    const tools=createGoalServiceTools(service);
    const request={requestId:'inspect',expectedVersion:1,command:{action:'inspect',decision:'verify',reason:'test'}};
    const step=tools.find(t=>t.name==='goal_step')!;
    expect((await step.execute('call',request)).isError).toBe(false);
    expect((await step.execute('retry',request)).isError).toBe(false);
    const record=(await db.query<{record:ManagedGoal}>('SELECT record FROM managed_goals WHERE id=$1',[m.id]))[0].record;
    expect(record.version).toBe(2);expect(record.progressVersion).toBe(3);expect(record.id).toBe(m.id);
    expect(record.state.phase).toBe('check');
    const check=await step.execute('check',{requestId:'check',expectedVersion:2,command:{action:'check',outcome:'improved',evidence:[]}});
    expect(check.isError).toBe(true);
    expect((await service.status())?.version).toBe(2);
    const wrong=createManagedGoalService({goalId:m.id,userId:1,projectId:'p',sessionId:'s',rootTurnId:'old-root'},{validate:async()=>true});
    await expect(wrong.status()).rejects.toThrow('GOAL_SCOPE_DENIED');
  });

  it('uses actual turn ownership for common goal tool writes and denies uninstalled receipt checks', async()=>{
    const f=await fixture();const m=await managerFixture();
    m.goal.sessionId=f.scope.sessionId;m.goal.activeExecution={rootTurnId:f.scope.rootTurnId,startProgressVersion:1};
    await db.query('UPDATE managed_goals SET record=$2::jsonb WHERE id=$1',[m.id,JSON.stringify(m.goal)]);
    const scope={goalId:m.id,userId:1,projectId:'p',sessionId:f.scope.sessionId,rootTurnId:f.scope.rootTurnId};
    const guard=createManagedGoalGuard({...scope,sourceUserMessageId:f.scope.rootTurnId,ownerToken:'fixture-token',ownerBootId:'fixture-boot'});
    const service=createManagedGoalService(scope,guard);
    expect((await service.execute({requestId:'inspect',expectedVersion:1,command:{action:'inspect',decision:'verify',reason:'verify',strategyChanged:false}})).state.phase).toBe('check');
    await expect(service.execute({requestId:'check',expectedVersion:2,command:{action:'check',outcome:'improved',evidence:[]}})).rejects.toThrow('GOAL_COMMAND_DENIED');
    await db.query("UPDATE agent_turns SET owner_token='changed' WHERE root_turn_id=$1",[f.scope.rootTurnId]);
    await expect(service.status()).rejects.toThrow('GOAL_ACCESS_DENIED');
  });

  it.each(['own','wrong-token','other-tool','uncertain','expired','null-lease'] as const)('only exempts the exact running goal wrapper: %s',async mode=>{
    const f=await fixture();const m=await managerFixture();
    m.goal.sessionId=f.scope.sessionId;m.goal.activeExecution={rootTurnId:f.scope.rootTurnId,startProgressVersion:1};
    await db.query('UPDATE managed_goals SET record=$2::jsonb WHERE id=$1',[m.id,JSON.stringify(m.goal)]);
    const id=randomUUID();
    await db.query(`INSERT INTO side_effect_executions(id,root_turn_id,session_id,tool_name,tool_call_id,operation_id,semantic_hash,status,owner_token,lease_until)
      VALUES($1,$2,$3,$4,'call',$1,'fixture',$5,'effect-token',NOW()+interval '5 minutes')`,
      [id,f.scope.rootTurnId,f.scope.sessionId,mode==='other-tool'?'bash':'goal_step',mode==='uncertain'?'uncertain':'running']);
    if(mode==='expired') await db.query("UPDATE side_effect_executions SET lease_until=NOW()-interval '1 second' WHERE id=$1",[id]);
    if(mode==='null-lease') await db.query('UPDATE side_effect_executions SET lease_until=NULL WHERE id=$1',[id]);
    const scope={goalId:m.id,userId:1,projectId:'p',sessionId:f.scope.sessionId,rootTurnId:f.scope.rootTurnId};
    const guard=createManagedGoalGuard({...scope,sourceUserMessageId:f.scope.rootTurnId,ownerToken:'fixture-token',ownerBootId:'fixture-boot',currentTool:{executionId:id,ownerToken:mode==='wrong-token'?'wrong':'effect-token'}});
    const service=createManagedGoalService(scope,guard);
    const promise=service.execute({requestId:'inspect',expectedVersion:1,command:{action:'inspect',decision:'verify',reason:'verify',strategyChanged:false}});
    if(mode==='own') expect((await promise).state.phase).toBe('check');
    else await expect(promise).rejects.toThrow('GOAL_COMMAND_DENIED');
  });

  it('admits an explicit goal once then connects common tools to terminal next-intent creation',async()=>{
    const f=await fixture();
    const binding={...f.scope,ownerToken:'fixture-token',ownerBootId:'fixture-boot',explicitlyAuthorized:true};
    const start=createManagedGoalStart(binding);
    const input={action:'start',goal:'fixture work',criteria:[{id:'test',description:'passes'}],maxCycles:3};
    const [g,duplicate]=await Promise.all([start(input),start(input)]);
    expect(duplicate.id).toBe(g.id);
    const scope={...f.scope,goalId:g.id};
    const service=createManagedGoalService(scope,createManagedGoalGuard({...scope,sourceUserMessageId:f.scope.rootTurnId,ownerToken:'fixture-token',ownerBootId:'fixture-boot'}));
    const tools=createGoalServiceTools(service);
    expect((await tools.find(t=>t.name==='goal_step')!.execute('inspect',{requestId:'i',expectedVersion:1,command:{action:'inspect',decision:'change',reason:'fix'}})).isError).toBe(false);
    const terminalId=f.scope.rootTurnId;
    const manager=createGoalManager(createPostgresGoalManagerStore(createManagedGoalTerminalObserver({goalId:g.id,userId:1,projectId:'p',sessionId:f.scope.sessionId,userMessageId:f.scope.rootTurnId})));
    expect((await manager.onTerminal(g.id,terminalId)).kind).toBe('ignore');
    expect(await settleAgentTurn({rootTurnId:f.scope.rootTurnId,token:'fixture-token',state:'completed'})).toBe(true);
    const settled=await manager.onTerminal(g.id,terminalId);
    expect(settled).toMatchObject({kind:'settle',reason:'next_execution',intent:{goalId:g.id,phase:'change'}});
    expect(await db.query('SELECT intent_key FROM goal_dispatch_intents WHERE goal_id=$1',[g.id])).toHaveLength(1);
    await expect(start({...input,goal:'different'})).rejects.toThrow('GOAL_START_DENIED');
    await expect(createManagedGoalStart({...binding,explicitlyAuthorized:false})(input)).rejects.toThrow('GOAL_START_DENIED');
  });

  it('completes start/tool/check/terminal using immutable DB evidence and rejects changed artifacts',async()=>{
    const f=await fixture();const binding={...f.scope,ownerToken:'fixture-token',ownerBootId:'fixture-boot',explicitlyAuthorized:true};
    const g=await createManagedGoalStart(binding)({action:'start',goal:'fixture',criteria:[{id:'a',description:'passes'}],maxCycles:3});
    let digest='a'.repeat(64);
    const verify=createManagedGoalEvidenceVerifier({trustedVerifierIds:new Set(['fixture-verifier']),digest:async()=>digest});
    const scope={...f.scope,goalId:g.id};
    const service=createManagedGoalService(scope,createManagedGoalGuard({...binding,goalId:g.id,sourceUserMessageId:f.scope.rootTurnId},verify));
    await service.execute({requestId:'inspect',expectedVersion:1,command:{action:'inspect',decision:'verify',reason:'verify',strategyChanged:false}});
    const receipt=randomUUID();
    // Test-issued evidence, not a live checker receipt.
    await db.query(`INSERT INTO managed_goal_evidence(id,goal_id,root_turn_id,criterion_id,criterion_hash,revision,artifact_digest,verifier_id,status)
      VALUES($1,$2,$3,'a',$4,'initial',$5,'fixture-verifier','passed')`,[receipt,g.id,f.scope.rootTurnId,criterionHash({id:'a',description:'passes'}),digest]);
    const check={requestId:'check',expectedVersion:2,command:{action:'check' as const,outcome:'improved' as const,evidence:[{criterionId:'a',revision:'initial',reference:receipt,passed:true}]}};
    await expect(service.execute({...check,command:{...check.command,evidence:[{...check.command.evidence[0],reference:'missing'}]}})).rejects.toThrow('GOAL_COMMAND_DENIED');
    await expect(service.execute({...check,command:{...check.command,evidence:[{...check.command.evidence[0],passed:false}]}})).rejects.toThrow('GOAL_COMMAND_DENIED');
    const untrusted=createManagedGoalEvidenceVerifier({trustedVerifierIds:new Set(),digest:async()=>digest});
    const current=(await db.query<{record:ManagedGoal}>('SELECT record FROM managed_goals WHERE id=$1',[g.id]))[0].record;
    expect(await db.transaction(client=>untrusted(client,current,check.command))).toBe(false);
    digest='b'.repeat(64);await expect(service.execute(check)).rejects.toThrow('GOAL_COMMAND_DENIED');
    digest='a'.repeat(64);expect((await service.execute(check)).state.status).toBe('completed');
    await expect(db.query("UPDATE managed_goal_evidence SET status='failed' WHERE id=$1",[receipt])).rejects.toThrow('IMMUTABLE_GOAL_EVIDENCE');
    await settleAgentTurn({rootTurnId:f.scope.rootTurnId,token:'fixture-token',state:'completed'});
    const manager=createGoalManager(createPostgresGoalManagerStore(createManagedGoalTerminalObserver({goalId:g.id,userId:1,projectId:'p',sessionId:f.scope.sessionId,userMessageId:f.scope.rootTurnId},verify)));
    expect(await manager.onTerminal(g.id,f.scope.rootTurnId)).toMatchObject({kind:'settle',reason:'completed'});
    expect(await db.query('SELECT intent_key FROM goal_dispatch_intents WHERE goal_id=$1',[g.id])).toHaveLength(0);
  });

 it('issues evidence from a real assertion process then completes the goal',async()=>{
  const f=await fixture();const binding={...f.scope,ownerToken:'fixture-token',ownerBootId:'fixture-boot',explicitlyAuthorized:true};
  const g=await createManagedGoalStart(binding)({action:'start',goal:'actual assertion',criteria:[{id:'a',description:'node assertion passes'}],maxCycles:2});
  await testFs.mkdir('work/goal-check-tests',{recursive:true});
  const root=await testFs.mkdtemp(testPath.resolve('work/goal-check-tests/pg-'));
  try {
   await testFs.writeFile(testPath.join(root,'check.cjs'),"require('node:assert/strict').equal(6*7,42)");
   const spec={root,files:['check.cjs'],executable:process.execPath,args:['check.cjs'],timeoutMs:2000,maxOutputBytes:10000};
   const verify=createManagedGoalEvidenceVerifier({trustedVerifierIds:new Set(['node-assert']),digest:async()=>digestCodeManifest(root,spec.files)});
   const scope={...f.scope,goalId:g.id};const guard=createManagedGoalGuard({...binding,goalId:g.id,sourceUserMessageId:f.scope.rootTurnId},verify);
   const service=createManagedGoalService(scope,guard);
   await service.execute({requestId:'inspect',expectedVersion:1,command:{action:'inspect',decision:'verify',reason:'check',strategyChanged:false}});
   const receipt=await issueManagedCodeReceipt({goalId:g.id,criterionId:'a',verifierId:'node-assert',spec,guard},new AbortController().signal);
   expect(receipt?.status).toBe('passed');
   expect((await service.execute({requestId:'check',expectedVersion:2,command:{action:'check',outcome:'improved',evidence:[{criterionId:'a',revision:'initial',reference:receipt!.id,passed:true}]}})).state.status).toBe('completed');
   await settleAgentTurn({rootTurnId:f.scope.rootTurnId,token:'fixture-token',state:'completed'});
   const manager=createGoalManager(createPostgresGoalManagerStore(createManagedGoalTerminalObserver({goalId:g.id,userId:1,projectId:'p',sessionId:f.scope.sessionId,userMessageId:f.scope.rootTurnId},verify)));
   expect(await manager.onTerminal(g.id,f.scope.rootTurnId)).toMatchObject({kind:'settle',reason:'completed'});
  } finally {await testFs.rm(root,{recursive:true,force:true});}
 });

 it('persists AI review acceptance and never overwrites it with late stop',async()=>{
  const f=await fixture();const id=randomUUID();const goal={objective:'notice',criteria:[{id:'a',description:'clear'}]};
  await db.query('INSERT INTO reviewed_goal_runs(id,session_id,source_message_id,owner_token,goal) VALUES($1,$2,$3,$4,$5)',[id,f.scope.sessionId,f.scope.rootTurnId,'owner',goal]);
  const store=createReviewedGoalStore({id,ownerToken:'owner'},db.transaction,async()=>true);
  const snapshot={revision:'r1',content:'notice'};const review={verdict:'pass' as const,criteria:[{id:'a',passed:true,reason:'clear'}],requiredChanges:[]};
  expect(await store.accept(snapshot,review,async()=>({...snapshot,revision:'r2'}))).toBe(false);
  expect(await store.accept(snapshot,review,async()=>snapshot)).toBe(true);
  await store.finish({status:'stopped',reason:'cancelled',rounds:1});
  expect((await db.query<{state:string}>('SELECT state FROM reviewed_goal_runs WHERE id=$1',[id]))[0].state).toBe('completed');
  await expect(createReviewedGoalStore({id,ownerToken:'wrong'},db.transaction,async()=>true).allowed()).rejects.toThrow('REVIEW_RUN_DENIED');
 });
 it('does not permit finish to bypass AI acceptance and serializes stop against pass',async()=>{
  const f=await fixture();const id=randomUUID();const goal={objective:'notice',criteria:[{id:'a',description:'clear'}]};
  await db.query('INSERT INTO reviewed_goal_runs(id,session_id,source_message_id,owner_token,goal) VALUES($1,$2,$3,$4,$5)',[id,f.scope.sessionId,f.scope.rootTurnId,'owner',goal]);
  const store=createReviewedGoalStore({id,ownerToken:'owner'},db.transaction,async()=>true);
  const review={verdict:'pass' as const,criteria:[{id:'a',passed:true,reason:'clear'}],requiredChanges:[]};
  await expect(store.finish({status:'completed',rounds:1,review})).rejects.toThrow('REVIEW_ACCEPT_REQUIRED');
  await store.finish({status:'stopped',reason:'cancelled',rounds:1});
  const snapshot={revision:'r',content:'notice'};
  expect(await store.accept(snapshot,review,async()=>snapshot)).toBe(false);
  expect(await store.allowed()).toBe(false);
 });

});
