// Opt-in: uses an isolated synthetic schema; never run against a production database.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
const state = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock('../../db/pg-repo.js', () => ({ query: async (sql: string, params: unknown[]) => (await state.pool!.query(sql, params)).rows }));
import { config } from '../../config.js';
import { sleep, cancelSessionSleep, interruptRestartedSleepTurns } from './sleep.js';
const url = process.env.SLEEP_TEST_DATABASE_URL;
const schema = `sleep_test_${process.pid}`;
const suite = url ? describe : describe.skip;
suite('PostgreSQL sleep restart fencing', () => {
  beforeAll(async () => {
    const admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`); await admin.end();
    state.pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await state.pool.query(`CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT, role TEXT, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE agent_turns(root_turn_id TEXT PRIMARY KEY, session_id TEXT, state TEXT, owner_token TEXT, owner_boot_id TEXT,
      lease_until TIMESTAMPTZ, next_attempt_at TIMESTAMPTZ, terminal_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT NOW(), last_failure_class TEXT, last_error TEXT);`);
  });
  afterAll(async () => { await state.pool?.end(); state.pool = null; });
  it('fences Pi and legacy Claude, preserves same-boot waits and completed turns, and is idempotent', async () => {
    for (const [id, boot, status] of [['pi', 'old', 'waiting'], ['claude', 'old', 'waiting'], ['live', config.serverEpoch, 'waiting'], ['done', 'old', 'completed']]) {
      await state.pool!.query(`INSERT INTO messages(id,session_id,role,metadata) VALUES($1,$1,'user',$2::jsonb)`, [id, JSON.stringify({ sleep_wait: { status, ownerBootId: boot } })]);
    }
    await state.pool!.query(`INSERT INTO agent_turns(root_turn_id,session_id,state,owner_token,owner_boot_id,lease_until)
      VALUES('pi','pi','running','token','old',NOW()+INTERVAL '2 minutes'),('live','live','running','live-token',$1,NOW()+INTERVAL '2 minutes')`, [config.serverEpoch]);
    expect(await interruptRestartedSleepTurns()).toEqual(expect.arrayContaining([{ rootTurnId: 'pi', sessionId: 'pi' }, { rootTurnId: 'claude', sessionId: 'claude' }]));
    const turns = (await state.pool!.query(`SELECT root_turn_id,state,owner_token,last_failure_class FROM agent_turns ORDER BY root_turn_id`)).rows;
    expect(turns).toEqual([
      { root_turn_id: 'claude', state: 'needs_attention', owner_token: null, last_failure_class: 'sleep_restart_interrupted' },
      { root_turn_id: 'live', state: 'running', owner_token: 'live-token', last_failure_class: null },
      { root_turn_id: 'pi', state: 'needs_attention', owner_token: null, last_failure_class: 'sleep_restart_interrupted' },
    ]);
    expect(await interruptRestartedSleepTurns()).toEqual([]);
  });
  it('records cancellation on the latest durable user message when no root binding is supplied', async () => {
    await state.pool!.query(`INSERT INTO messages(id,session_id,role,metadata) VALUES('fallback','fallback','user','{}'::jsonb)`);
    const run = sleep({ durationSeconds: 1800, reason: '확인' }, { sessionId: 'fallback' });
    cancelSessionSleep('fallback');
    expect(await run).toMatchObject({ cancelled: true });
    const row = (await state.pool!.query(`SELECT metadata->'sleep_wait' AS wait FROM messages WHERE id='fallback'`)).rows[0];
    expect(row.wait).toMatchObject({ cancelled: true, status: 'cancelled', durationSeconds: 1800 });
  });
});
