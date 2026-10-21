/** Explicit opt-in disposable PostgreSQL; never reads the application's DB URL. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { companySessionMetadataSql, sessionAudienceSql } from './session-audience.js';

const database = vi.hoisted(() => ({ client: null as Client | null }));
vi.mock('../../db/pg-repo.js', () => ({
  queryOne: async (sql: string, params: unknown[]) => (await database.client!.query(sql, params)).rows[0] ?? null,
}));
vi.mock('./project-membership-manager.js', () => ({
  isProjectMember: async (projectId: string, userId: number) =>
    (await database.client!.query('SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2', [projectId, userId])).rowCount !== 0,
  getAccessibleProjectIds: vi.fn(),
}));
vi.mock('../session/session-share-manager.js', () => ({
  hasInternalShareAccess: async (sessionId: string, userId: number) =>
    (await database.client!.query("SELECT 1 FROM session_shares WHERE session_id=$1 AND target_user_id=$2 AND revoked=0", [sessionId, userId])).rowCount !== 0,
}));
import { canAccessSession, canSendSessionMessage, canWriteSessionContent } from './project-access.js';

const bin = '/usr/lib/postgresql/18/bin';
let root: string;
let started = false;
let client: Client;

describe.skipIf(process.env.TEAM_SESSION_AUDIENCE_PG_TEST !== '1')('pre-LIMIT Session audience in disposable PostgreSQL', () => {
  beforeAll(async () => {
    await fs.mkdir(path.join(process.cwd(), 'work'), { recursive: true });
    root = await fs.mkdtemp(path.join(process.cwd(), 'work', 'team-session-audience-pg-'));
    execFileSync(`${bin}/initdb`, ['-D', path.join(root, 'data'), '-A', 'trust', '--no-locale'], { stdio: 'pipe' });
    execFileSync(`${bin}/pg_ctl`, ['-D', path.join(root, 'data'), '-l', path.join(root, 'server.log'), '-o', `-k ${root} -p 56432 -h ''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    client = new Client({ host: root, port: 56432, database: 'postgres', user: process.env.USER });
    await client.connect();
    database.client = client;
    await client.query(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT, disabled INTEGER, approval_status TEXT);
      CREATE TABLE projects (id TEXT PRIMARY KEY, archived INTEGER, lifecycle_status TEXT);
      CREATE TABLE project_agent_profiles (project_id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE project_members (project_id TEXT, user_id INTEGER, role TEXT DEFAULT 'member');
      CREATE TABLE room_members (room_id TEXT, user_id INTEGER);
      CREATE TABLE session_shares (session_id TEXT, target_user_id INTEGER, share_type TEXT, revoked INTEGER);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER, project_id TEXT, visibility TEXT, room_id TEXT, label TEXT);
    `);
    // Apply the real current migration, not invented team tables.
    await client.query(await fs.readFile('packages/backend/db/migrations/236_agent_teams.sql', 'utf8'));
  }, 30000);

  afterAll(async () => {
    try { if (client) await client.end(); }
    finally {
      if (started) execFileSync(`${bin}/pg_ctl`, ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
      if (root) await fs.rm(root, { recursive: true, force: true });
    }
  });
  beforeEach(async () => {
    vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '1');
    await client.query(`TRUNCATE agent_team_members, agent_team_projects, agent_teams, sessions, session_shares, project_members, room_members, project_agent_profiles, projects, users CASCADE;
      INSERT INTO users VALUES (10,'member',0,'active'),(20,'member',0,'active');
      INSERT INTO projects VALUES ('p',0,'active');
      INSERT INTO project_agent_profiles VALUES ('p','active');
      INSERT INTO agent_teams(id,name,state) VALUES ('t','Team','active');
      INSERT INTO agent_team_projects VALUES ('p','t');
      INSERT INTO agent_team_members VALUES ('t',10,'active');
      INSERT INTO sessions VALUES ('s',10,'p','private',NULL,NULL);`);
  });
  afterEach(() => vi.unstubAllEnvs());

  async function visible(actor = 10, predicate = sessionAudienceSql('s', '$1')) {
    return (await client.query(`SELECT s.id FROM sessions s WHERE ${predicate} ORDER BY s.id LIMIT 1`, [actor])).rows.map(row => row.id);
  }

  it.each(['private', 'project'])('shows the current team owner %s without Project membership', async visibility => {
    await client.query('UPDATE sessions SET visibility=$1', [visibility]);
    expect(await visible()).toEqual(['s']);
  });
  it('does not admit a nonowner by team use alone', async () => {
    await client.query("UPDATE sessions SET user_id=20, visibility='project'");
    expect(await visible()).toEqual([]);
    await client.query("INSERT INTO project_members(project_id,user_id) VALUES ('p',10)");
    expect(await visible()).toEqual(['s']);
  });
  it.each([10, 20])('denies revoked team access despite retained Project membership and internal share (owner=%s)', async owner => {
    await client.query("INSERT INTO project_members(project_id,user_id) VALUES ('p',10); INSERT INTO session_shares VALUES ('s',10,'internal',0); UPDATE agent_team_members SET state='disabled'");
    await client.query("UPDATE sessions SET user_id=$1,visibility='project'", [owner]);
    // Prove that the remaining Project grant actually admits this exact fixture
    // with rollout off; enabled must AND the gate, never OR a legacy bypass.
    vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', undefined);
    expect(await visible()).toEqual(['s']);
    vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '1');
    expect(await visible()).toEqual([]);
    expect(await visible(10, companySessionMetadataSql('s', '$1'))).toEqual([]);
    expect((await client.query("SELECT count(*)::int AS n FROM session_shares WHERE revoked=0")).rows[0].n).toBe(1);
  });
  it('denies a revoked private owner despite retained Project membership and internal share', async () => {
    await client.query("INSERT INTO project_members(project_id,user_id) VALUES ('p',10), ('p',20); INSERT INTO session_shares VALUES ('s',10,'internal',0); UPDATE agent_team_members SET state='disabled'");
    vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', undefined);
    expect(await visible()).toEqual(['s']);
    vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '1');
    expect(await visible()).toEqual([]);
    expect(await visible(20)).toEqual([]);
  });
  it('denies both the former team owner and a Project reader after team revocation', async () => {
    await client.query("INSERT INTO project_members(project_id,user_id) VALUES ('p',10), ('p',20); INSERT INTO agent_team_members VALUES ('t',20,'active'); UPDATE sessions SET visibility='project'");
    expect(await visible(10)).toEqual(['s']);
    expect(await visible(20)).toEqual(['s']);
    await client.query("UPDATE agent_team_members SET state='disabled'");
    expect(await visible(10)).toEqual([]);
    expect(await visible(20)).toEqual([]);
  });
  it.each([10, 20])('cross-checks REAL read/send/content guards with PG after team revocation (owner=%s)', async owner => {
    await client.query("INSERT INTO project_members(project_id,user_id) VALUES ('p',10); INSERT INTO session_shares VALUES ('s',10,'internal',0)");
    await client.query("UPDATE sessions SET user_id=$1,visibility='project'", [owner]);
    for (const authorize of [canAccessSession, canSendSessionMessage, canWriteSessionContent]) {
      expect(await authorize('s',10,'member')).toMatchObject({ allowed: true });
    }
    expect(await visible()).toEqual(['s']);
    await client.query("UPDATE agent_team_members SET state='disabled'");
    for (const authorize of [canAccessSession, canSendSessionMessage, canWriteSessionContent]) {
      expect(await authorize('s',10,'member')).toMatchObject({ allowed: false, status: 403 });
    }
    expect(await visible()).toEqual([]);
    expect((await client.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n).toBe(1);
    expect((await client.query('SELECT count(*)::int AS n FROM project_members')).rows[0].n).toBe(1);
    expect((await client.query('SELECT count(*)::int AS n FROM session_shares WHERE revoked=0')).rows[0].n).toBe(1);
  });
  it('denies missing team membership and disabled teams', async () => {
    await client.query('DELETE FROM agent_team_members');
    expect(await visible()).toEqual([]);
    await client.query("INSERT INTO agent_team_members VALUES ('t',10,'active'); UPDATE agent_teams SET state='disabled'");
    expect(await visible()).toEqual([]);
  });
  it.each([
    "UPDATE users SET disabled=1 WHERE id=10",
    "UPDATE users SET approval_status='pending' WHERE id=10",
    "UPDATE users SET role='viewer' WHERE id=10",
    "UPDATE users SET role='guest' WHERE id=10",
    "UPDATE projects SET archived=1",
    "UPDATE projects SET lifecycle_status='retired'",
    "UPDATE project_agent_profiles SET status='retired'",
    'DELETE FROM project_agent_profiles',
  ])('rejects ineligible current facts despite retained Project membership: %s', async change => {
    await client.query("INSERT INTO project_members(project_id,user_id) VALUES ('p',10)");
    await client.query(change);
    expect(await visible()).toEqual([]);
  });
  it('allows ready Agent profiles', async () => {
    await client.query("UPDATE project_agent_profiles SET status='ready'");
    expect(await visible()).toEqual(['s']);
  });
  it('does not let the existing active-admin Project audience bypass team revocation', async () => {
    await client.query("UPDATE users SET role='admin' WHERE id=10; UPDATE agent_team_members SET state='disabled'; UPDATE sessions SET user_id=20,visibility='project'");
    expect(await visible()).toEqual([]);
  });
  it('preserves teamless membership ACL without creating an owner override', async () => {
    await client.query('DELETE FROM agent_team_projects');
    expect(await visible()).toEqual([]);
    await client.query("INSERT INTO project_members(project_id,user_id) VALUES ('p',10)");
    expect(await visible()).toEqual(['s']);
    await client.query("UPDATE sessions SET user_id=20,visibility='project'");
    expect(await visible()).toEqual(['s']);
  });
  it.each(['viewer', 'guest'])('preserves teamless %s owner read without requiring an Agent profile', async role => {
    await client.query('DELETE FROM agent_team_projects; DELETE FROM project_agent_profiles');
    await client.query('UPDATE users SET role=$1 WHERE id=10', [role]);
    await client.query("INSERT INTO project_members(project_id,user_id) VALUES ('p',10)");
    expect(await visible()).toEqual(['s']);
  });
  it('keeps another owner private despite valid team and Project membership', async () => {
    await client.query("INSERT INTO project_members(project_id,user_id) VALUES ('p',10); UPDATE sessions SET user_id=20");
    expect(await visible()).toEqual([]);
  });
  it.each(['channel_agent', 'channel_ai'])('keeps room-bound %s channel audience independent', async label => {
    await client.query("UPDATE agent_team_members SET state='disabled'; INSERT INTO room_members VALUES ('r',10)");
    await client.query("UPDATE sessions SET user_id=20,room_id='r',label=$1,visibility='project'", [label]);
    expect(await visible()).toEqual(['s']);
    await client.query('DELETE FROM room_members');
    expect(await visible()).toEqual([]);
  });
  it.each([null, 'spawned'])('does not exclude a room without an execution label from revocation (%s)', async label => {
    await client.query("UPDATE agent_team_members SET state='disabled'; INSERT INTO project_members(project_id,user_id) VALUES ('p',10)");
    await client.query("UPDATE sessions SET room_id='r',label=$1,visibility='project'", [label]);
    expect(await visible()).toEqual([]);
  });
  it('does not exclude an execution label without a room', async () => {
    await client.query("UPDATE agent_team_members SET state='disabled'; UPDATE sessions SET label='channel_agent'");
    expect(await visible()).toEqual([]);
  });
  it('preserves project-less owner privacy', async () => {
    await client.query('UPDATE sessions SET project_id=NULL');
    expect(await visible()).toEqual(['s']);
    expect(await visible(20)).toEqual([]);
  });
  it('filters revoked rows before LIMIT so they cannot crowd out valid rows', async () => {
    await client.query(`INSERT INTO projects VALUES ('q',0,'active'); INSERT INTO project_agent_profiles VALUES ('q','active');
      INSERT INTO agent_teams(id,name,state) VALUES ('u','Other','active'); INSERT INTO agent_team_projects VALUES ('q','u');
      INSERT INTO sessions VALUES ('a-hidden',10,'q','private',NULL,NULL);`);
    expect(await visible()).toEqual(['s']);
  });
  it('uses legacy SQL with opt-in off even if team use is revoked', async () => {
    vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', undefined);
    await client.query("UPDATE agent_team_members SET state='disabled'; INSERT INTO project_members(project_id,user_id) VALUES ('p',10)");
    expect(await visible()).toEqual(['s']);
  });
  it('propagates schema absence when enabled but does not require schema when off', async () => {
    await client.query('BEGIN; DROP TABLE agent_team_projects');
    try {
      await expect(visible()).rejects.toMatchObject({ code: '42P01' });
    } finally { await client.query('ROLLBACK'); }
    await client.query('BEGIN; DROP TABLE agent_team_projects');
    try {
      vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', undefined);
      await client.query("INSERT INTO project_members(project_id,user_id) VALUES ('p',10)");
      expect(await visible()).toEqual(['s']);
    } finally { await client.query('ROLLBACK'); }
  });
});
