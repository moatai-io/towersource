import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const state = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock('../../db/pg-repo.js', () => ({
  query: async (sql: string, args?: unknown[]) => (await state.pool!.query(sql, args)).rows,
  queryOne: async (sql: string, args?: unknown[]) => (await state.pool!.query(sql, args)).rows[0],
  execute: async (sql: string, args?: unknown[]) => ({ changes: (await state.pool!.query(sql, args)).rowCount ?? 0 }),
  withClient: (db: any) => ({ query: async (sql: string, args?: unknown[]) => (await db.query(sql, args)).rows,
    queryOne: async (sql: string, args?: unknown[]) => (await db.query(sql, args)).rows[0],
    execute: async (sql: string, args?: unknown[]) => ({ changes: (await db.query(sql, args)).rowCount ?? 0 }) }),
  transaction: async (fn: any) => {
    const db = await state.pool!.connect();
    try {
      await db.query('BEGIN');
      const result = await fn(db);
      await db.query('COMMIT'); return result;
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  },
}));
import { secretariatStore as store } from './store.js';

// This test never connects to Tower/production PG. It creates an isolated temporary cluster.
const bin = process.env.TOWER_TEST_POSTGRES_BIN || ['/usr/lib/postgresql/18/bin', '/usr/lib/postgresql/14/bin'].find(b => existsSync(path.join(b, 'initdb')));
const enabled = !!bin && process.getuid?.() !== 0;
let root: string; let started = false;
describe.skipIf(!enabled)('Secretariat isolated PostgreSQL SQL/races', () => {
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'tower-secretariat-test-'));
    execFileSync(path.join(bin!, 'initdb'), ['-D', path.join(root, 'data'), '-A', 'trust', '--no-locale', '-U', 'test'], { stdio: 'ignore' });
    const port = 54000 + process.pid % 1000;
    execFileSync(path.join(bin!, 'pg_ctl'), ['-D', path.join(root, 'data'), '-l', path.join(root, 'postgres.log'), '-o', `-h '' -k ${root} -p ${port}`, '-w', 'start'], { stdio: 'ignore' });
    started = true;
    state.pool = new Pool({ host: root, port, user: 'test', database: 'postgres', max: 6 });
    await state.pool.query(`CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, disabled INTEGER DEFAULT 0, approval_status TEXT DEFAULT 'active', role TEXT DEFAULT 'member');
      CREATE TABLE projects(id TEXT PRIMARY KEY, archived INTEGER DEFAULT 0, lifecycle_status TEXT DEFAULT 'active');
      CREATE TABLE sessions(id TEXT PRIMARY KEY, name TEXT DEFAULT 'session', visibility TEXT DEFAULT 'private', parent_session_id TEXT, label TEXT, room_id TEXT, user_id INTEGER, project_id TEXT, archived INTEGER DEFAULT 0);
      CREATE TABLE messages(id SERIAL PRIMARY KEY, session_id TEXT, role TEXT, username TEXT, parent_tool_use_id TEXT, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE project_members(project_id TEXT, user_id INTEGER);
      CREATE TABLE agent_workers(backing_session_id TEXT);
      CREATE TABLE work_ledger_records(id TEXT PRIMARY KEY, owner_user_id INTEGER, session_id TEXT, project_id TEXT,
        status TEXT, run_title TEXT, outcome TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());
      INSERT INTO users(id) VALUES (7), (8), (9), (10), (11), (12);
      INSERT INTO projects VALUES ('p');
      INSERT INTO sessions(id,user_id,project_id) VALUES ('s',7,'p'),('s8',8,'p');
      INSERT INTO messages(session_id,role) VALUES ('s','user'),('s8','user');
      INSERT INTO project_members VALUES ('p',7),('p',8);
      INSERT INTO work_ledger_records(id,owner_user_id,session_id,project_id,status,run_title,outcome)
        VALUES ('w',7,'s','p','running','초안','비교표 작성'),('w8',8,'s8','p','running','다른 사용자','공유하지 않음');`);
    await state.pool.query(readFileSync('packages/backend/db/migrations/238_secretariat.sql', 'utf8'));
    await state.pool.query(readFileSync('packages/backend/db/migrations/239_secretariat_popup.sql', 'utf8'));
    await state.pool.query(readFileSync('packages/backend/db/migrations/241_secretariat_delivery_diagnostics.sql', 'utf8'));
  }, 30_000);
  afterAll(async () => {
    await state.pool?.end(); state.pool = null;
    if (started) execFileSync(path.join(bin!, 'pg_ctl'), ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
    if (root) rmSync(root, { recursive: true, force: true });
  });
  it('applies schema in isolated cluster, defaults off and source key dedup persists', async () => {
    expect(await store.settings(7)).toEqual({ enabled: false });
    await store.setEnabled(7, true); const candidate = (await store.candidates(7))[0];
    expect((await store.candidates(7)).map(c => c.id)).toEqual(['s']);
    const claim = await store.claim(7); expect(claim).not.toBeNull();
    expect(await store.insert(claim!, candidate, { title: 'title', body: '비교표를 준비할까요?' })).toBe(true);
    expect(await store.candidates(7)).toEqual([]); expect(await store.hasUnread(7)).toBe(true);
    expect(await store.claim(7)).toBeNull(); expect(await store.insert(claim!, candidate, { title: 'title', body: 'test?' })).toBe(false);
    const proposal = (await store.proposals(7))[0]; expect(await store.read(8, proposal.id)).toBe(false);
    expect(await store.read(7, proposal.id)).toBe(true); expect(await store.read(7, proposal.id)).toBe(true);
    await store.finish(claim!, 'proposed');
    await state.pool!.query("UPDATE secretariat_settings SET next_run_at = NOW() - INTERVAL '1 minute' WHERE user_id = 7");
    expect(await store.claim(7)).toBeNull(); // persistent same-occurrence dedup after completion/restart
  });
  it('one replica wins per-user claim; other workers never get a billable claim', async () => {
    await store.setEnabled(8, true);
    const results = await Promise.all(Array.from({ length: 5 }, () => store.claim(8)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const claim = results.find(Boolean)!;
    expect(await store.sourceCurrent(8, (await store.candidates(8))[0])).toBe(true);
    const candidate = (await store.candidates(8))[0];
    await state.pool!.query("UPDATE sessions SET archived=1 WHERE id='s8'");
    expect(await store.sourceCurrent(8, candidate)).toBe(false);
    expect(await store.insert(claim, candidate, { title: 'title', body: 'test?' })).toBe(false);
    await store.finish(claim, 'skipped');
  });
  it('unread users do not starve due users; defer advances skipped users', async () => {
    for (const userId of [9, 10, 11, 12]) await store.setEnabled(userId, true);
    await state.pool!.query(`INSERT INTO secretariat_proposals(id,user_id,source_key,title,body,session_id,project_id)
      VALUES ('u9',9,'9','title','body?','s','p'),('u10',10,'10','title','body?','s','p'),('u11',11,'11','title','body?','s','p');
      UPDATE secretariat_settings SET next_run_at = NOW() - INTERVAL '1 day', claim_until = NULL WHERE user_id IN (9,10,11,12);`);
    expect(await store.dueUsers()).toContain(12); expect(await store.dueUsers()).not.toContain(9);
    await store.defer(12); expect(await store.dueUsers()).not.toContain(12);
  });
  it('OFF committed before insert lock prevents stale proposal, including OFF-ON generation', async () => {
    await state.pool!.query("UPDATE secretariat_settings SET next_run_at = NOW() - INTERVAL '1 day' WHERE user_id = 12");
    const claim = await store.claim(12); expect(claim).not.toBeNull();
    await state.pool!.query(`INSERT INTO sessions(id,user_id,project_id) VALUES ('s12',12,'p');
      INSERT INTO messages(session_id,role) VALUES ('s12','user'); INSERT INTO project_members VALUES ('p',12);
      INSERT INTO work_ledger_records(id,owner_user_id,session_id,project_id,status,run_title,outcome) VALUES ('w12',12,'s12','p','running','title','outcome');`);
    const candidate = (await store.candidates(12))[0];
    const transaction = await state.pool!.connect();
    try {
      await transaction.query('BEGIN'); await transaction.query('UPDATE secretariat_settings SET enabled = FALSE, generation = generation + 1 WHERE user_id = 12');
      const insert = store.insert(claim!, candidate, { title: 'title', body: 'test?' });
      await new Promise(resolve => setTimeout(resolve, 30));
      await transaction.query('COMMIT'); expect(await insert).toBe(false);
      await store.setEnabled(12, true); expect(await store.insert(claim!, candidate, { title: 'title', body: 'test?' })).toBe(false);
    } finally { await transaction.query('ROLLBACK'); transaction.release(); }
  });
  it('inactive source excludes model candidate and revoked membership prevents insert', async () => {
    const candidate = (await store.candidates(12))[0];
    await state.pool!.query("UPDATE sessions SET archived=1 WHERE id='s12'");
    expect(await store.candidates(12)).toEqual([]);
    await state.pool!.query("UPDATE sessions SET archived=0 WHERE id='s12'");
    const ss = (await state.pool!.query('SELECT claim_token, generation FROM secretariat_settings WHERE user_id=12')).rows[0];
    await state.pool!.query("DELETE FROM project_members WHERE user_id=12");
    expect(await store.insert({ userId: 12, token: ss.claim_token, generation: ss.generation }, candidate, { title: 'title', body: 'test?' })).toBe(false);
  });
  it('popup claims once, preserves unread on close, skip enforces hour cooldown', async () => {
    await store.setEnabled(8, true);
    await state.pool!.query("UPDATE secretariat_proposals SET read_at = NOW() WHERE user_id=8");
    await state.pool!.query(`INSERT INTO secretariat_proposals(id,user_id,source_key,title,body,session_id,project_id)
      VALUES ('popup',8,'popup','title','body?','s8','p')`);
    expect(await store.respond(7, 'popup', 'show')).toBe(false);
    const claims = await Promise.all([store.respond(8, 'popup', 'show'), store.respond(8, 'popup', 'show')]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await store.hasUnread(8)).toBe(true);
    expect((await store.proposals(8)).find(p => p.id === 'popup')?.shownAt).toBeTruthy();
    expect(await store.respond(8, 'popup', 'skip')).toBe(true);
    expect(await store.hasUnread(8)).toBe(false);
    expect(await store.claim(8)).toBeNull();
  });

  it('24 hour rest acknowledges and persists a full day cooldown', async () => {
    await store.setEnabled(8, true);
    await state.pool!.query(`INSERT INTO secretariat_proposals(id,user_id,source_key,title,body,session_id,project_id)
      VALUES ('rest',8,'rest','title','body?','s8','p')`);
    expect(await store.respond(8, 'rest', 'today')).toBe(true);
    expect(await store.hasUnread(8)).toBe(false);
    const row = (await state.pool!.query(`SELECT next_run_at > NOW() + INTERVAL '23 hours' AS resting FROM secretariat_settings WHERE user_id=8`)).rows[0];
    expect(row.resting).toBe(true);
  });

  it('includes directly participating shared sessions but not mere membership or helper sessions', async () => {
    await state.pool!.query(`UPDATE users SET username='member12' WHERE id=12;
      INSERT INTO project_members(project_id,user_id) VALUES ('p',12);
      INSERT INTO sessions(id,user_id,project_id,name,visibility) VALUES ('shared',7,'p','shared','project'),('unrelated',7,'p','other','project'),('helper',12,'p','helper','private');
      INSERT INTO messages(session_id,role,username) VALUES ('shared','user','member12'),('unrelated','user','someone'),('helper','user','member12');
      INSERT INTO agent_workers(backing_session_id) VALUES ('helper')`);
    const ids = (await store.candidates(12)).map(c => c.id);
    expect(ids).toContain('shared'); expect(ids).not.toContain('unrelated'); expect(ids).not.toContain('helper');
    await state.pool!.query("DELETE FROM project_members WHERE user_id=12");
    expect(await store.candidates(12)).toEqual([]);
  });

  it('caps at ten and sorts by conversation activity rather than session metadata', async () => {
    await state.pool!.query(`INSERT INTO project_members(project_id,user_id) VALUES ('p',12);
      INSERT INTO sessions(id,user_id,project_id,name) SELECT 'recent-' || n,12,'p','recent' FROM generate_series(1,12) n;
      INSERT INTO messages(session_id,role,created_at) SELECT 'recent-' || n,'user',NOW() + n * INTERVAL '1 minute' FROM generate_series(1,12) n`);
    const candidates = await store.candidates(12);
    expect(candidates).toHaveLength(10);
    expect(candidates[0].id).toBe('recent-12');
    expect(candidates[9].id).toBe('recent-3');
    await state.pool!.query("UPDATE sessions SET visibility='private' WHERE id='shared'");
    expect(candidates.some(c => c.id === 'shared')).toBe(false);
  });

  it('manual claim works while off without changing consent and shares the lease', async () => {
    await state.pool!.query("INSERT INTO users(id,role) VALUES (99,'member'); INSERT INTO project_members VALUES ('p',99)");
    const claim = await store.claim(99, true);
    expect(claim?.manual).toBe(true);
    expect(await store.settings(99)).toEqual({ enabled: false });
    expect(await store.stillAllowed(claim!)).toBe(true);
    expect(await store.claim(99, true)).toBeNull();
    await store.finish(claim!, 'skipped');
    expect(await store.claim(99, true)).toBeNull();
    expect(await store.claim(99)).toBeNull();
  });

});
