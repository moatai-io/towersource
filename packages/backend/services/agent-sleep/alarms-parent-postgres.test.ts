vi.mock('../pm/project-access.js',()=>({canSendSessionMessage:async()=>({allowed:true})}));
// Opt-in isolated PostgreSQL schema. Never point WAIT_TEST_DATABASE_URL at production.
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock('../../db/pg-repo.js', () => ({
  query: async (sql: string, params: unknown[]) => (await state.pool!.query(sql, params)).rows,
  queryOne: async (sql: string, params: unknown[]) => (await state.pool!.query(sql, params)).rows[0] ?? null,
  transaction: async (fn: (c: any) => Promise<unknown>) => {
    const c = await state.pool!.connect();
    try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  },
}));
import { scheduleWait, readWaitAlarm, changeWaitAlarm, invalidateWaitAlarm, clearRequestedWait, admitWaitAlarm, validateWaitAlarmRoot, listDueWaitAlarms, retireSupersededWaitRetries } from './alarms.js';
const url = process.env.WAIT_TEST_DATABASE_URL;
const schema = `wait_parent_${process.pid}`;
(url ? describe : describe.skip)('durable wait PostgreSQL contract', () => {
  beforeAll(async () => {
    const admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`); await admin.end();
    state.pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await state.pool.query(`CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT DEFAULT 'admin',username TEXT DEFAULT 'test',disabled INTEGER DEFAULT 0,approval_status TEXT DEFAULT 'active'); CREATE TABLE projects(id TEXT PRIMARY KEY,archived INTEGER DEFAULT 0); INSERT INTO users(id) VALUES(1);
      CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id INTEGER,archived INTEGER DEFAULT 0, project_id TEXT, engine TEXT DEFAULT 'pi');
      CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT,role TEXT,content TEXT, metadata JSONB DEFAULT '{}',created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE agent_turns(root_turn_id TEXT PRIMARY KEY,session_id TEXT,state TEXT,owner_token TEXT,lease_until TIMESTAMPTZ,accepted_at TIMESTAMPTZ,execution_started_at TIMESTAMPTZ,owner_boot_id TEXT,terminal_at TIMESTAMPTZ,completed_at TIMESTAMPTZ,last_failure_class TEXT,last_error TEXT,next_attempt_at TIMESTAMPTZ,updated_at TIMESTAMPTZ DEFAULT NOW());`);
    await state.pool.query(readFileSync('packages/backend/db/migrations/242_session_wait_alarms.sql','utf8'));
  });
  afterAll(async () => { await state.pool?.end(); const admin=new Pool({connectionString:url});await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end(); });
  async function seed(session: string) {
    await state.pool!.query(`INSERT INTO sessions(id,user_id) VALUES($1,1);`,[session]);
    await state.pool!.query(`INSERT INTO messages(id,session_id,role) VALUES($1,$2,'user')`,[`${session}-root`,session]);
    await state.pool!.query(`INSERT INTO agent_turns(root_turn_id,session_id,state,owner_token,lease_until) VALUES($1,$2,'running','owner',NOW()+INTERVAL '1 hour')`,[`${session}-root`,session]);
    return {sessionId:session,rootTurnId:`${session}-root`};
  }
  it('persists a day-long alarm without releasing the active source ownership', async () => {
    const ctx=await seed('day'); await scheduleWait({durationSeconds:86400,reason:'翌日の結果確認'},ctx);
    clearRequestedWait(ctx.sessionId);
    const alarm=await readWaitAlarm(ctx.sessionId); expect(alarm?.status).toBe('pending');
    expect(Date.parse(alarm!.wakeAt)-Date.now()).toBeGreaterThan(86_390_000);
    const turn=(await state.pool!.query(`SELECT state,owner_token FROM agent_turns WHERE root_turn_id=$1`,[ctx.rootTurnId])).rows[0];
    expect(turn).toEqual({state:'running',owner_token:'owner'});
  });
  it('rejects stale versions and persists reschedule and cancellation', async () => {
    const ctx=await seed('change'); await scheduleWait({durationSeconds:86400,reason:'確認'},ctx);
    const alarm=(await readWaitAlarm(ctx.sessionId))!;
    const changed=await changeWaitAlarm(ctx.sessionId,'reschedule',{id:alarm.id,version:alarm.version,wakeAt:new Date(Date.now()+7200000).toISOString()});
    expect(changed.version).toBe(alarm.version+1);
    await expect(changeWaitAlarm(ctx.sessionId,'now',{id:alarm.id,version:alarm.version})).rejects.toMatchObject({status:409});
    await invalidateWaitAlarm(ctx.sessionId,'cancelled'); expect((await readWaitAlarm(ctx.sessionId))?.status).toBe('cancelled');
  });
  it('admits a due alarm once after the source has cleanly released ownership', async () => {
    const ctx=await seed('admit'); await scheduleWait({durationSeconds:86400,reason:'Check'},ctx);
    const alarm=(await readWaitAlarm(ctx.sessionId))!;
    await changeWaitAlarm(ctx.sessionId,'now',{id:alarm.id,version:alarm.version});
    expect(await admitWaitAlarm(ctx.sessionId,alarm.id)).toBeNull();
    await state.pool!.query(`UPDATE agent_turns SET state='completed',owner_token=NULL,lease_until=NULL WHERE root_turn_id=$1`,[ctx.rootTurnId]);
    const results=await Promise.all([admitWaitAlarm(ctx.sessionId,alarm.id),admitWaitAlarm(ctx.sessionId,alarm.id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await readWaitAlarm(ctx.sessionId))?.status).toBe('admitted');
    const message=(await state.pool!.query('SELECT id FROM messages WHERE id=$1',[results.find(Boolean)!.messageId])).rows[0];
    expect(message).toBeTruthy();
    expect(await validateWaitAlarmRoot(ctx.sessionId,message.id)).toBe(true);
    await invalidateWaitAlarm(ctx.sessionId,'cancelled');
    expect(await validateWaitAlarmRoot(ctx.sessionId,message.id)).toBe(false);
    await invalidateWaitAlarm(ctx.sessionId,'cancelled');
    expect((await readWaitAlarm(ctx.sessionId))?.status).toBe('cancelled');
  });
  it('does not replace newer human instructions with a stale wait', async () => {
    const ctx=await seed('newer');
    await state.pool!.query(`INSERT INTO messages(id,session_id,role,created_at) VALUES('newer-human','newer','user',NOW()+INTERVAL '1 second')`);
    await expect(scheduleWait({durationSeconds:86400,reason:'確認'},ctx)).rejects.toMatchObject({status:409});
    expect(await readWaitAlarm(ctx.sessionId)).toBeNull();
  });
  it('does not block an idle alarm on historical needs_attention roots', async () => {
    const ctx=await seed('historical');
    await scheduleWait({durationSeconds:1,reason:'check'},ctx);
    await state.pool!.query("UPDATE agent_turns SET state='completed',owner_token=NULL,lease_until=NULL WHERE root_turn_id=$1",[ctx.rootTurnId]);
    await state.pool!.query("INSERT INTO agent_turns(root_turn_id,session_id,state) VALUES('old-error',$1,'needs_attention')",[ctx.sessionId]);
    await state.pool!.query("UPDATE session_wait_alarms SET wake_at=NOW()-INTERVAL '1 minute' WHERE session_id=$1",[ctx.sessionId]);
    expect((await listDueWaitAlarms()).some(a=>a.session_id===ctx.sessionId)).toBe(true);
    await state.pool!.query("UPDATE agent_turns SET state='running' WHERE root_turn_id='old-error'");
    expect((await listDueWaitAlarms()).some(a=>a.session_id===ctx.sessionId)).toBe(false);
    await state.pool!.query("UPDATE agent_turns SET state='waiting_retry',owner_token=NULL,lease_until=NULL,next_attempt_at=NOW()-INTERVAL '1 day' WHERE root_turn_id='old-error'");
    expect((await listDueWaitAlarms()).some(a=>a.session_id===ctx.sessionId)).toBe(false);
  });

  it('retires only a superseded unowned retry and admits the alarm once', async()=>{
    const ctx=await seed('stale-retry');
    await scheduleWait({durationSeconds:1,reason:'check'},ctx);
    await state.pool!.query("UPDATE agent_turns SET state='completed',owner_token=NULL,lease_until=NULL WHERE root_turn_id=$1",[ctx.rootTurnId]);
    await state.pool!.query("INSERT INTO messages(id,session_id,role,created_at) VALUES('stale-root',$1,'user',NOW()-INTERVAL '1 day')",[ctx.sessionId]);
    await state.pool!.query("INSERT INTO agent_turns(root_turn_id,session_id,state) VALUES('stale-root',$1,'waiting_retry')",[ctx.sessionId]);
    await state.pool!.query("UPDATE session_wait_alarms SET wake_at=NOW()-INTERVAL '1 minute' WHERE session_id=$1",[ctx.sessionId]);
    expect((await listDueWaitAlarms()).some(a=>a.session_id===ctx.sessionId)).toBe(false);
    await state.pool!.query("UPDATE agent_turns SET owner_token='live',lease_until=NOW()+INTERVAL '1 hour' WHERE root_turn_id='stale-root'");
    await retireSupersededWaitRetries();
    expect((await state.pool!.query("SELECT state FROM agent_turns WHERE root_turn_id='stale-root'")).rows[0].state).toBe('waiting_retry');
    await state.pool!.query("UPDATE agent_turns SET owner_token=NULL,lease_until=NULL WHERE root_turn_id='stale-root'");
    await retireSupersededWaitRetries();
    const alarm=(await listDueWaitAlarms()).find(a=>a.session_id===ctx.sessionId)!;
    expect(alarm).toBeTruthy();
    expect(await admitWaitAlarm(ctx.sessionId,alarm.id,alarm.version)).toBeTruthy();
    expect(await admitWaitAlarm(ctx.sessionId,alarm.id,alarm.version)).toBeNull();
  });

});
