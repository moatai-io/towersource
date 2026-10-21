/** Opt-in, self-contained PostgreSQL cluster under work/. Never uses DATABASE_URL. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listCurrentTeamWorkspaceIds, loadTeamWorkspacePolicyInput } from './team-repository.js';

let pool: Pool;
let root: string | undefined;
let started = false;
const pgBin = process.env.TEAM_TEST_PG_BIN || '/usr/lib/postgresql/18/bin';
const migrationPath = path.resolve('packages/backend/db/migrations/236_agent_teams.sql');
vi.mock('../../db/pg-repo.js', () => ({ queryOne: async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows[0] }));
const context = { userId: 1, agentProjectId: 'a' };

describe.skipIf(process.env.RUN_TEAM_REPOSITORY_PG !== '1')('team repository isolated PostgreSQL', () => {
  beforeAll(async () => {
    // A private Unix socket and new data directory isolate this fixture from any running database.
    root = fs.mkdtempSync(path.resolve('work/team-repository-pg-'));
    execFileSync(path.join(pgBin, 'initdb'), ['-D', path.join(root, 'data'), '-A', 'trust', '-U', 'fixture', '--no-locale'], { stdio: 'pipe' });
    execFileSync(path.join(pgBin, 'pg_ctl'), ['-D', path.join(root, 'data'), '-l', path.join(root, 'postgres.log'), '-o', `-h '' -k '${root}' -p 55443`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    pool = new Pool({ host: root, port: 55443, user: 'fixture', database: 'postgres', max: 1 });
    await pool.query(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT NOT NULL, disabled INTEGER DEFAULT 0, approval_status TEXT NOT NULL DEFAULT 'active');
      CREATE TABLE projects (id TEXT PRIMARY KEY, archived INTEGER DEFAULT 0, lifecycle_status TEXT NOT NULL DEFAULT 'active');
      CREATE TABLE project_agent_profiles (project_id TEXT PRIMARY KEY REFERENCES projects(id), status TEXT DEFAULT 'active');
      CREATE TABLE project_members (project_id TEXT REFERENCES projects(id), user_id INTEGER REFERENCES users(id), role TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), user_id INTEGER REFERENCES users(id));
    `);
    await pool.query(fs.readFileSync(path.resolve('packages/backend/db/migrations/196_agent_workspace_grants.sql'), 'utf8'));
    await pool.query(fs.readFileSync(migrationPath, 'utf8'));
  }, 60000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (root && started) execFileSync(path.join(pgBin, 'pg_ctl'), ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
    // Delete only the temporary fixture created by this test, never supplied paths.
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }, 30000);

  beforeEach(async () => {
    await pool.query(`TRUNCATE users, projects, agent_teams CASCADE;
      INSERT INTO users (id,role) VALUES (1,'member'),(2,'member'),(3,'admin'),(4,'viewer'),(5,'guest');
      INSERT INTO projects (id) VALUES ('a'),('b'),('c'),('unregistered'),('teamless');
      INSERT INTO project_agent_profiles (project_id) SELECT id FROM projects;
      INSERT INTO agent_teams (id,name) VALUES ('ta','Team A'),('tb','Team B');
      INSERT INTO agent_team_members (team_id,user_id) VALUES ('ta',1),('tb',1),('ta',4),('ta',5);
      INSERT INTO agent_team_projects (project_id,team_id) VALUES ('a','ta'),('b','ta'),('c','tb'),('unregistered','ta');
      INSERT INTO agent_workspaces (id,owner_project_id,kind) VALUES ('wa','a','project'),('wb','b','project'),('wc','c','project');
    `);
  });

  it('executes real SQL and restricts a multiple-team user to the Agent single team without source Project membership', async () => {
    expect(await listCurrentTeamWorkspaceIds(context)).toEqual(['wa', 'wb']);
    expect(await listCurrentTeamWorkspaceIds({ ...context, agentProjectId: 'c' })).toEqual(['wc']);
    expect((await pool.query('SELECT * FROM project_members')).rows).toEqual([]);
  });

  it('rejects nonmembers including admin, and viewer/guest members', async () => {
    for (const userId of [2, 3, 4, 5]) {
      await expect(listCurrentTeamWorkspaceIds({ ...context, userId })).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
    }
  });

  it('rechecks current removal and disabled membership', async () => {
    expect(await listCurrentTeamWorkspaceIds(context)).toEqual(['wa', 'wb']);
    await pool.query("UPDATE agent_team_members SET state='disabled' WHERE team_id='ta' AND user_id=1");
    await expect(listCurrentTeamWorkspaceIds(context)).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
    await pool.query("DELETE FROM agent_team_members WHERE team_id='ta' AND user_id=1");
    await expect(listCurrentTeamWorkspaceIds(context)).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it.each([
    'UPDATE users SET disabled=1 WHERE id=1',
    "UPDATE users SET approval_status='pending' WHERE id=1",
    "UPDATE users SET approval_status='rejected' WHERE id=1",
    "DELETE FROM project_agent_profiles WHERE project_id='a'",
    "UPDATE project_agent_profiles SET status=NULL WHERE project_id='a'",
    "UPDATE projects SET archived=1 WHERE id='a'",
    "UPDATE projects SET lifecycle_status='retired' WHERE id='a'",
    "UPDATE project_agent_profiles SET status='inactive' WHERE project_id='a'",
    "UPDATE agent_teams SET state='disabled' WHERE id='ta'",
  ])('fails closed after inactive current facts: %s', async sql => {
    await pool.query(sql);
    await expect(listCurrentTeamWorkspaceIds(context)).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it.each([
    "UPDATE agent_workspaces SET state='disabled' WHERE id='wb'",
    "UPDATE projects SET archived=1 WHERE id='b'",
    "UPDATE projects SET lifecycle_status='retired' WHERE id='b'",
    "UPDATE project_agent_profiles SET status='inactive' WHERE project_id='b'",
    "DELETE FROM project_agent_profiles WHERE project_id='b'",
    "UPDATE project_agent_profiles SET status=NULL WHERE project_id='b'",
    "UPDATE agent_team_projects SET team_id='tb' WHERE project_id='b'",
  ])('excludes inactive, retired or moved source workspace: %s', async sql => {
    await pool.query(sql);
    expect(await listCurrentTeamWorkspaceIds(context)).toEqual(['wa']);
  });

  it('retains ready Agents, explicit legacy branching and missing-context failure', async () => {
    await pool.query("UPDATE project_agent_profiles SET status='ready' WHERE project_id='a'");
    expect(await listCurrentTeamWorkspaceIds(context)).toEqual(['wa', 'wb']);
    expect((await loadTeamWorkspacePolicyInput({ ...context, agentProjectId: 'teamless' })).agent.teamId).toBeNull();
    await expect(listCurrentTeamWorkspaceIds({ ...context, agentProjectId: 'teamless' })).rejects.toThrow('TEAM_WORKSPACE_CONTEXT_REQUIRED');
    await expect(loadTeamWorkspacePolicyInput({ ...context, agentProjectId: 'missing' })).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
    await expect(loadTeamWorkspacePolicyInput({ ...context, userId: 99 })).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it('allows ready source profiles and excludes retired source lifecycles', async () => {
    await pool.query("UPDATE project_agent_profiles SET status='ready' WHERE project_id='b'");
    expect(await listCurrentTeamWorkspaceIds(context)).toEqual(['wa', 'wb']);
    await pool.query("UPDATE projects SET lifecycle_status='retiring' WHERE id='b'");
    expect(await listCurrentTeamWorkspaceIds(context)).toEqual(['wa']);
  });

  it('accepts 256 entries and fails closed on a bounded 257-entry aggregate', async () => {
    await pool.query(`INSERT INTO projects (id) SELECT 'extra-' || n FROM generate_series(1,254) AS n;
      INSERT INTO project_agent_profiles (project_id) SELECT id FROM projects WHERE id LIKE 'extra-%';
      INSERT INTO agent_team_projects (project_id,team_id) SELECT id,'ta' FROM projects WHERE id LIKE 'extra-%';
      INSERT INTO agent_workspaces (id,owner_project_id,kind) SELECT 'w-' || id,id,'project' FROM projects WHERE id LIKE 'extra-%';`);
    expect(await listCurrentTeamWorkspaceIds(context)).toHaveLength(256);
    await pool.query(`INSERT INTO projects (id) VALUES ('overflow');
      INSERT INTO project_agent_profiles (project_id) VALUES ('overflow');
      INSERT INTO agent_team_projects (project_id,team_id) VALUES ('overflow','ta');
      INSERT INTO agent_workspaces (id,owner_project_id,kind) VALUES ('w-overflow','overflow','project');`);
    await expect(loadTeamWorkspacePolicyInput(context)).rejects.toThrow('TEAM_WORKSPACE_INVENTORY_LIMIT');
    await pool.query(`INSERT INTO projects (id) VALUES ('overflow-2');
      INSERT INTO project_agent_profiles (project_id) VALUES ('overflow-2');
      INSERT INTO agent_team_projects (project_id,team_id) VALUES ('overflow-2','ta');
      INSERT INTO agent_workspaces (id,owner_project_id,kind) VALUES ('w-overflow-2','overflow-2','project');`);
    await expect(listCurrentTeamWorkspaceIds(context)).rejects.toThrow('TEAM_WORKSPACE_INVENTORY_LIMIT');
  });

  it('migration is repeatable, preserves relationships and seeds no Session, Project membership or direct grants', async () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');
    await pool.query(migration);
    await pool.query(migration);
    expect(await listCurrentTeamWorkspaceIds(context)).toEqual(['wa', 'wb']);
    for (const table of ['project_members', 'sessions', 'agent_workspace_grants']) {
      expect((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count).toBe(0);
    }
    await pool.query('BEGIN');
    try {
      await pool.query('TRUNCATE agent_teams CASCADE');
      await pool.query(migration);
      expect((await pool.query('SELECT count(*)::int AS count FROM agent_teams')).rows[0].count).toBe(0);
    } finally { await pool.query('ROLLBACK'); }
  });

  it.each([
    "INSERT INTO agent_team_projects VALUES ('a','tb')",
    "INSERT INTO agent_team_projects VALUES ('missing','ta')",
    "INSERT INTO agent_team_projects VALUES ('teamless','missing')",
    "INSERT INTO agent_team_members (team_id,user_id) VALUES ('ta',99)",
    "INSERT INTO agent_team_members (team_id,user_id) VALUES ('ta',1)",
    "INSERT INTO agent_teams VALUES ('invalid','Invalid','enabled')",
    "UPDATE agent_team_members SET state='unknown' WHERE user_id=1",
  ])('enforces uniqueness, references and state constraints: %s', async sql => {
    await expect(pool.query(sql)).rejects.toThrow();
  });
});
