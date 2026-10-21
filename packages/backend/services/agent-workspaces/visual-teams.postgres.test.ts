/** Explicit opt-in disposable PostgreSQL fixture; never uses application DB or migrations. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
let pool: Pool; let root: string | undefined; let started = false;
const bin = '/usr/lib/postgresql/18/bin';
vi.mock('../../db/pg-repo.js', () => ({ query: async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows, transaction: async (fn: (client: PoolClient) => Promise<unknown>) => {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
} }));
import { getVisualTeams, patchVisualTeams, VISUAL_TEAMS_SETTING_KEY } from './visual-teams.js';

describe.skipIf(process.env.VISUAL_TEAMS_PG_TEST !== '1')('visual teams disposable PostgreSQL', () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.resolve('work/visual-teams-pg-'));
    execFileSync(`${bin}/initdb`, ['-D', `${root}/data`, '-A', 'trust', '-U', 'fixture', '--no-locale'], { stdio: 'pipe' });
    execFileSync(`${bin}/pg_ctl`, ['-D', `${root}/data`, '-l', `${root}/postgres.log`, '-o', `-h '' -k '${root}' -p 55457`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    pool = new Pool({ host: root, port: 55457, user: 'fixture', database: 'postgres', max: 6 });
    await pool.query(`
      CREATE TABLE users(id INTEGER PRIMARY KEY, role TEXT, disabled INTEGER DEFAULT 0, approval_status TEXT DEFAULT 'active');
      CREATE TABLE projects(id TEXT PRIMARY KEY, user_id INTEGER, archived INTEGER DEFAULT 0, lifecycle_status TEXT DEFAULT 'active', access_scope TEXT DEFAULT 'company');
      CREATE TABLE project_members(project_id TEXT REFERENCES projects(id), user_id INTEGER REFERENCES users(id));
      CREATE TABLE app_settings(key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_by INTEGER REFERENCES users(id), updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE agent_teams(id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE agent_team_members(team_id TEXT, user_id INTEGER);
      CREATE TABLE agent_workspace_grants(project_id TEXT, user_id INTEGER);
      CREATE TABLE sessions(id TEXT PRIMARY KEY, project_id TEXT, user_id INTEGER);
      CREATE TABLE credentials(id TEXT PRIMARY KEY, project_id TEXT);
    `);
  }, 30000);
  afterAll(async () => {
    if (pool) await pool.end();
    if (started && root) execFileSync(`${bin}/pg_ctl`, ['-D', `${root}/data`, '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
    // Retain isolated fixture evidence in work/; no application files removed.
  }, 15000);
  beforeEach(async () => {
    await pool.query(`
      TRUNCATE users, projects, project_members, app_settings, agent_teams, agent_team_members, agent_workspace_grants, sessions, credentials;
      INSERT INTO users(id,role) VALUES (1,'admin'),(2,'member'),(3,'operator'),(4,'viewer');
      INSERT INTO projects(id,user_id,access_scope) VALUES ('a',1,'company'),('b',2,'limited'),('restricted',2,'admin'),('op-owned',3,'admin');
      INSERT INTO projects(id,archived,lifecycle_status) VALUES ('archived',1,'active'),('retired',0,'retired');
      INSERT INTO project_members VALUES ('a',1),('b',1),('restricted',1),('op-owned',1),('a',2),('restricted',4);
      INSERT INTO agent_teams VALUES ('acl-team','Existing ACL');
      INSERT INTO agent_team_members VALUES ('acl-team',2);
      INSERT INTO agent_workspace_grants VALUES ('a',2);
      INSERT INTO sessions VALUES ('s1','a',2);
      INSERT INTO credentials VALUES ('c1','a');
    `);
  });
  async function authority() {
    const { rows: [row] } = await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(a)) FROM users a) AS users,
      (SELECT jsonb_agg(to_jsonb(a)) FROM projects a) AS projects,
      (SELECT jsonb_agg(to_jsonb(a)) FROM project_members a) AS memberships,
      (SELECT jsonb_agg(to_jsonb(a)) FROM agent_teams a) AS teams,
      (SELECT jsonb_agg(to_jsonb(a)) FROM agent_team_members a) AS team_members,
      (SELECT jsonb_agg(to_jsonb(a)) FROM agent_workspace_grants a) AS grants,
      (SELECT jsonb_agg(to_jsonb(a)) FROM sessions a) AS sessions,
      (SELECT jsonb_agg(to_jsonb(a)) FROM credentials a) AS credentials`);
    return row;
  }
  async function create() { return patchVisualTeams(1, { expectedVersion: 0, command: { kind: 'create', name: 'Visible team' } }); }
  it('persists JSONB and assigns/unassigns with zero authority side effects', async () => {
    const before = await authority();
    const created = await create(); const id = created.teams[0].id;
    const assigned = await patchVisualTeams(1, { expectedVersion: 1, command: { kind: 'assign', projectId: 'a', teamId: id } });
    expect(assigned.assignments).toEqual({ a: id });
    expect(await getVisualTeams(2)).toMatchObject({ version: 2, teams: created.teams, assignments: { a: id }, canManage: false });
    expect(await getVisualTeams(3)).toMatchObject({ version: 2, teams: [], assignments: {}, canManage: false });
    const removed = await patchVisualTeams(1, { expectedVersion: 2, command: { kind: 'assign', projectId: 'a', teamId: null } });
    expect(removed.assignments).toEqual({}); expect(removed.version).toBe(3);
    expect(await authority()).toEqual(before);
    expect((await pool.query('SELECT key, updated_by FROM app_settings')).rows).toEqual([{ key: VISUAL_TEAMS_SETTING_KEY, updated_by: 1 }]);
  });
  it('serializes concurrent first creates; exactly one commits and the other conflicts', async () => {
    const results = await Promise.allSettled([
      patchVisualTeams(1, { expectedVersion: 0, command: { kind: 'create', name: 'First' } }),
      patchVisualTeams(1, { expectedVersion: 0, command: { kind: 'create', name: 'Second' } }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    expect(await getVisualTeams(1)).toMatchObject({ version: 1, teams: [expect.any(Object)] });
  });
  it('uses canonical membership-only access, not ownership or operational roles', async () => {
    const created = await create(); const id = created.teams[0].id;
    let version = 1;
    for (const projectId of ['a','b','restricted','op-owned']) {
      await patchVisualTeams(1, { expectedVersion: version++, command: { kind: 'assign', projectId, teamId: id } });
    }
    expect((await getVisualTeams(2)).assignments).toEqual({ a: id });
    expect((await getVisualTeams(3)).assignments).toEqual({});
    expect((await getVisualTeams(4)).assignments).toEqual({ restricted: id });
    await pool.query("DELETE FROM project_members WHERE user_id = 2; UPDATE projects SET lifecycle_status = 'retired' WHERE id = 'b'");
    expect((await getVisualTeams(2)).assignments).toEqual({});
    await pool.query('DELETE FROM project_members WHERE user_id = 1');
    const admin = await getVisualTeams(1);
    expect(admin.assignments).toEqual({});
    expect(admin.teams).toEqual(created.teams);
    expect(admin.canManage).toBe(true);
  });
  it('rejects archived/retired/nonexistent Project without writing', async () => {
    const created = await create(); const before = await getVisualTeams(1);
    for (const projectId of ['archived','retired','missing']) {
      await expect(patchVisualTeams(1, { expectedVersion: 1, command: { kind: 'assign', projectId, teamId: created.teams[0].id } })).rejects.toMatchObject({ status: 404 });
    }
    expect(await getVisualTeams(1)).toEqual(before);
  });
  it('reads current role, approval and disabled state instead of token authority', async () => {
    await pool.query("UPDATE users SET role = 'operator' WHERE id = 1");
    await expect(create()).rejects.toMatchObject({ status: 403 });
    await pool.query("UPDATE users SET role = 'admin', approval_status = 'pending' WHERE id = 1");
    await expect(getVisualTeams(1)).rejects.toMatchObject({ status: 403 });
    await pool.query("UPDATE users SET approval_status = 'active', disabled = 1 WHERE id = 1");
    await expect(create()).rejects.toMatchObject({ status: 403 });
    expect((await pool.query('SELECT * FROM app_settings')).rows).toHaveLength(0);
  });
});
