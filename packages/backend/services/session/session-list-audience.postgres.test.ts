/** Disposable SQL fixture for actual Session list queries; no application DB URL. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ client: null as Client | null }));
vi.mock('../../db/pg-repo.js', () => ({
  query: async (sql: string, params: unknown[]) => (await m.client!.query(sql, params)).rows,
  queryOne: async (sql: string, params: unknown[]) => (await m.client!.query(sql, params)).rows[0] ?? null,
  execute: vi.fn(),
}));
vi.mock('../pm/project-membership-manager.js', () => ({
  getAccessibleProjectIds: async (userId: number) => (await m.client!.query('SELECT project_id FROM project_members WHERE user_id=$1', [userId])).rows.map(r => r.project_id),
}));
vi.mock('../workspace/jsonl-utils.js', () => ({ findJsonlFileForSession: vi.fn() }));
vi.mock('../auth/credential-store.js', () => ({ getConfigDir: vi.fn() }));
vi.mock('../../engines/index.js', () => ({ getAllRunningSessionIds: vi.fn(() => []) }));
vi.mock('../../engines/pi/clone.js', () => ({ clonePiSessionFile: vi.fn() }));
vi.mock('../../engines/pi/rehydrate.js', () => ({ rehydratePiSessionFromMessages: vi.fn() }));
vi.mock('../../config.js', () => ({ config: { defaultEngine: 'pi' }, normalizePiSessionModelId: vi.fn() }));
import { getSessions, getArchivedSessions } from './session-manager.js';
const bin = '/usr/lib/postgresql/18/bin';
let root: string;
let started = false;
const sidebar = async (userId = 10, limit = 20) => (await getSessions(userId, 'member', { sidebarOnly: true, limit })).map(s => s.id);
const archived = async () => (await getArchivedSessions(10, 'member')).map(s => s.id);

describe.skipIf(process.env.TEAM_SESSION_LIST_PG_TEST !== '1')('actual Session list SQL in isolated PostgreSQL', () => {
  beforeAll(async () => {
    await fs.mkdir(path.join(process.cwd(), 'work'), { recursive: true });
    root = await fs.mkdtemp(path.join(process.cwd(), 'work/team-session-list-pg-'));
    execFileSync(`${bin}/initdb`, ['-D', `${root}/data`, '-A', 'trust', '--no-locale', '-U', 'list_fixture'], { stdio: 'pipe' });
    execFileSync(`${bin}/pg_ctl`, ['-D', `${root}/data`, '-l', `${root}/postgres.log`, '-o', `-k ${root} -p 55498 -h ''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    m.client = new Client({ host: root, port: 55498, user: 'list_fixture', database: 'postgres' });
    await m.client.connect();
    await m.client.query(`
      CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, role TEXT, disabled INTEGER DEFAULT 0, approval_status TEXT DEFAULT 'active');
      CREATE TABLE projects(id TEXT PRIMARY KEY, archived INTEGER DEFAULT 0, lifecycle_status TEXT DEFAULT 'active');
      CREATE TABLE project_agent_profiles(project_id TEXT PRIMARY KEY, status TEXT DEFAULT 'active');
      CREATE TABLE project_members(project_id TEXT, user_id INTEGER);
      CREATE TABLE room_members(room_id TEXT, user_id INTEGER);
      CREATE TABLE administrator_participations(project_id TEXT, room_id TEXT, user_id INTEGER, left_at TIMESTAMPTZ);
      CREATE TABLE user_session_favorites(user_id INTEGER, session_id TEXT);
      CREATE TABLE session_user_states(session_id TEXT, user_id INTEGER, participated_at TIMESTAMPTZ,
        subscription_state TEXT, subscribed_from_sequence INTEGER, last_read_ai_sequence INTEGER);
      CREATE TABLE agent_workers(id TEXT, backing_session_id TEXT, supervisor_session_id TEXT, name TEXT, role TEXT, visibility TEXT, status TEXT, kind TEXT, metadata JSONB);
    `);
    await m.client.query(await fs.readFile('packages/backend/db/migrations/008_sessions.sql', 'utf8'));
    await m.client.query(`ALTER TABLE sessions ADD COLUMN label TEXT, ADD COLUMN parent_session_id TEXT,
      ADD COLUMN archived_at TIMESTAMPTZ, ADD COLUMN last_final_ai_sequence INTEGER DEFAULT 0;
      ALTER TABLE messages ADD COLUMN username TEXT, ADD COLUMN metadata JSONB, ADD COLUMN is_error INTEGER`);
    await m.client.query(await fs.readFile('packages/backend/db/migrations/236_agent_teams.sql', 'utf8'));
  }, 30_000);
  afterAll(async () => {
    await m.client?.end();
    if (started) execFileSync(`${bin}/pg_ctl`, ['-D', `${root}/data`, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '1');
    await m.client!.query(`BEGIN;
      INSERT INTO users(id,username,role) VALUES (10,'owner','member'),(20,'peer','member');
      INSERT INTO projects(id) VALUES ('team-agent'),('legacy-agent');
      INSERT INTO project_agent_profiles(project_id) VALUES ('team-agent');
      INSERT INTO agent_teams(id,name) VALUES ('team','Team');
      INSERT INTO agent_team_projects VALUES ('team-agent','team');
      INSERT INTO agent_team_members(team_id,user_id) VALUES ('team',10),('team',20);
      INSERT INTO sessions(id,name,user_id,project_id,visibility,updated_at,archived) VALUES
        ('owner','Owner',10,'team-agent','private','2026-01-01',0),
        ('other','Other',20,'team-agent','project','2026-01-02',0),
        ('history','History',10,'team-agent','private','2026-01-01',1),
        ('legacy','Legacy',10,'legacy-agent','private','2026-01-01',0);
    `);
  });
  afterEach(async () => { await m.client!.query('ROLLBACK'); vi.unstubAllEnvs(); });

  it('returns team owner without Project membership, but not another owner or legacy Project', async () => {
    expect(await sidebar()).toEqual(['owner']);
    expect(await archived()).toEqual(['history']);
    expect(await sidebar(20)).toEqual(['other']);
  });
  it('filters inaccessible newer rows before LIMIT', async () => {
    expect(await sidebar(10, 1)).toEqual(['owner']);
  });
  it('does not use team membership alone to discover another Project-visible conversation', async () => {
    await m.client!.query("INSERT INTO project_members VALUES ('team-agent',10)");
    expect(await sidebar()).toEqual(['other', 'owner']);
  });
  it.each([
    "UPDATE agent_team_members SET state='disabled' WHERE user_id=10",
    "UPDATE agent_teams SET state='disabled'",
    "UPDATE users SET disabled=1 WHERE id=10",
    "UPDATE users SET approval_status='suspended' WHERE id=10",
    "UPDATE project_agent_profiles SET status='disabled'",
    "UPDATE projects SET lifecycle_status='retired' WHERE id='team-agent'",
  ])('denies sidebar and archived history after current team facts change: %s', async (sql) => {
    await m.client!.query("INSERT INTO project_members VALUES ('team-agent',10)");
    await m.client!.query(sql);
    expect(await sidebar()).toEqual([]);
    expect(await archived()).toEqual([]);
  });
  it('revokes owner discovery and own archived history', async () => {
    await m.client!.query("UPDATE agent_team_members SET state='disabled' WHERE user_id=10");
    expect(await sidebar()).toEqual([]);
    expect(await archived()).toEqual([]);
  });
  it('does not turn retained Project membership into private nonowner audience', async () => {
    await m.client!.query("INSERT INTO project_members VALUES ('team-agent',10); UPDATE agent_team_members SET state='disabled'; UPDATE sessions SET visibility='private'");
    expect(await sidebar()).toEqual([]);
  });
  it('preserves legacy sidebar membership and own-history behavior when off without team tables', async () => {
    vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '0');
    await m.client!.query('DROP TABLE agent_team_projects');
    expect(await sidebar()).toEqual([]);
    expect(await archived()).toEqual(['history']);
    await m.client!.query("INSERT INTO project_members VALUES ('team-agent',10)");
    expect(await sidebar()).toEqual(['other', 'owner']);
  });
  it('preserves teamless legacy Project discovery without a global team OR', async () => {
    await m.client!.query('DELETE FROM agent_team_projects');
    expect(await sidebar()).toEqual([]);
    expect(await archived()).toEqual(['history']);
    await m.client!.query("INSERT INTO project_members VALUES ('team-agent',10)");
    expect(await sidebar()).toEqual(['other', 'owner']);
  });
  it('propagates unavailable team facts instead of returning cached metadata', async () => {
    await m.client!.query('ALTER TABLE agent_team_projects RENAME TO unavailable_teams');
    await m.client!.query('SAVEPOINT unavailable');
    await expect(sidebar()).rejects.toMatchObject({ code: '42P01' });
    await m.client!.query('ROLLBACK TO SAVEPOINT unavailable');
    await expect(archived()).rejects.toMatchObject({ code: '42P01' });
  });
});
