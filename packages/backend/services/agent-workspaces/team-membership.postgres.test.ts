/** Opt-in isolated PostgreSQL cluster. Never reads an application DB URL. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveTeamAgentContext } from './team-context.js';
import { listCurrentTeamWorkspaces } from './team-inventory.js';

const state = vi.hoisted(() => ({ client: null as Client | null }));
vi.mock('../../db/pg-repo.js', () => ({
  queryOne: async (sql: string, params: unknown[]) => (await state.client!.query(sql, params)).rows[0] ?? null,
  query: async (sql: string, params: unknown[]) => (await state.client!.query(sql, params)).rows,
}));
const bin = '/usr/lib/postgresql/18/bin';
const migrationDirectory = path.join(process.cwd(), 'packages/backend/db/migrations');
let root: string | undefined;
let started = false;
let migration: string;
let baseline: unknown;

async function legacySnapshot() {
  const result = await state.client!.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM projects p) AS projects,
    (SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM users u) AS users,
    (SELECT jsonb_agg(to_jsonb(m) ORDER BY project_id, user_id) FROM project_members m) AS members,
    (SELECT jsonb_agg(to_jsonb(g) ORDER BY agent_project_id, workspace_id) FROM agent_workspace_grants g) AS grants,
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM sessions s) AS sessions,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY key) FROM app_settings a) AS settings`);
  return result.rows[0];
}

describe.skipIf(process.env.TEAM_MEMBERSHIP_PG_TEST !== '1')('isolated PostgreSQL team membership', () => {
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(process.cwd(), 'work/team-membership-pg-'));
    await fs.chmod(root, 0o700);
    execFileSync(`${bin}/initdb`, ['-D', `${root}/data`, '-A', 'trust', '--no-locale', '-U', 'team_fixture'], { stdio: 'pipe' });
    execFileSync(`${bin}/pg_ctl`, ['-D', `${root}/data`, '-l', `${root}/postgres.log`, '-o', `-k ${root} -p 55497 -c listen_addresses=''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    state.client = new Client({ host: root, port: 55497, user: 'team_fixture', database: 'postgres' });
    await state.client.connect();
    for (const file of ['007_users.sql', '008_sessions.sql', '009_projects.sql', '091_signup_invite_codes.sql', '107_project_agent_profiles.sql', '163_project_agent_lifecycle.sql', '196_agent_workspace_grants.sql']) {
      await state.client.query(await fs.readFile(path.join(migrationDirectory, file), 'utf8'));
    }
    await state.client.query(`
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO app_settings VALUES ('organization_execution_admission_user_ids', '[1]');
      INSERT INTO users (id, username, password_hash, role, disabled) VALUES
        (1, 'member', 'synthetic', 'member', 0), (2, 'admin', 'synthetic', 'admin', 0),
        (3, 'operator', 'synthetic', 'operator', 0), (4, 'viewer', 'synthetic', 'viewer', 0),
        (5, 'guest', 'synthetic', 'guest', 0), (6, 'disabled', 'synthetic', 'member', 1);
      INSERT INTO projects (id, name, root_path) VALUES
        ('agent-a', 'Agent A', '/synthetic/agent-a'), ('agent-b', 'Agent B', '/synthetic/agent-b'),
        ('teamless', 'Existing Agent', '/synthetic/teamless');
      INSERT INTO project_agent_profiles (project_id) VALUES ('agent-a'), ('agent-b'), ('teamless');
      INSERT INTO project_members (project_id, user_id, role) VALUES ('teamless', 1, 'owner'), ('agent-a', 2, 'viewer');
      INSERT INTO sessions (id, name, user_id, project_id, visibility) VALUES
        ('private-session', 'Private', 1, 'agent-a', 'private'), ('shared-session', 'Shared', 2, 'agent-b', 'shared');
      INSERT INTO agent_workspaces (id, owner_project_id, kind) VALUES ('workspace-a', 'agent-a', 'project');
      INSERT INTO agent_workspace_grants (agent_project_id, workspace_id, mode) VALUES ('agent-b', 'workspace-a', 'read');
    `);
    baseline = await legacySnapshot();
    migration = await fs.readFile(path.join(migrationDirectory, '236_agent_teams.sql'), 'utf8');
    await state.client.query(migration);
    await state.client.query(migration);
    for (const table of ['agent_teams', 'agent_team_members', 'agent_team_projects']) {
      expect((await state.client.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count).toBe(0);
    }
    expect(await legacySnapshot()).toEqual(baseline);
  }, 30_000);

  afterAll(async () => {
    await state.client?.end();
    if (started) execFileSync(`${bin}/pg_ctl`, ['-D', `${root}/data`, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await state.client!.query(`BEGIN;
      INSERT INTO agent_teams (id, name) VALUES ('team-a', 'Team A'), ('team-b', 'Team B');
      INSERT INTO agent_team_projects (project_id, team_id) VALUES ('agent-a', 'team-a'), ('agent-b', 'team-b');
      INSERT INTO agent_team_members (team_id, user_id) VALUES ('team-a', 1), ('team-a', 2), ('team-a', 3),
        ('team-a', 4), ('team-a', 5), ('team-a', 6);
    `);
  });
  afterEach(async () => { await state.client!.query('ROLLBACK'); });

  it('is additive, leaves legacy rows unchanged and can rerun with populated teams', async () => {
    await state.client!.query(migration);
    expect((await state.client!.query('SELECT state, version FROM agent_teams ORDER BY id')).rows)
      .toEqual([{ state: 'active', version: 1 }, { state: 'active', version: 1 }]);
    expect((await state.client!.query('SELECT count(*)::int AS count FROM agent_team_projects')).rows[0].count).toBe(2);
    expect(await legacySnapshot()).toEqual(baseline);
    expect((await state.client!.query(`SELECT count(*)::int AS count FROM pg_trigger
      WHERE tgrelid IN ('agent_teams'::regclass, 'agent_team_members'::regclass, 'agent_team_projects'::regclass)
        AND NOT tgisinternal`)).rows[0].count).toBe(0);
  });

  it('allows a person in several teams, without creating Project membership or Session sharing', async () => {
    await state.client!.query("INSERT INTO agent_team_members (team_id, user_id) VALUES ('team-b', 1)");
    expect((await state.client!.query('SELECT team_id FROM agent_team_members WHERE user_id=1 ORDER BY team_id')).rows)
      .toEqual([{ team_id: 'team-a' }, { team_id: 'team-b' }]);
    expect(await legacySnapshot()).toEqual(baseline);
  });

  it('disables affiliation without modifying grants, project folders, members or Sessions', async () => {
    await state.client!.query("UPDATE agent_team_members SET state='disabled'; UPDATE agent_teams SET state='disabled', version=version+1");
    expect(await legacySnapshot()).toEqual(baseline);
    await expect(resolveTeamAgentContext({ userId: 1, agentProjectId: 'agent-a' })).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it.each([
    ["INSERT INTO agent_team_projects VALUES ('agent-a', 'team-b')", '23505'],
    ["INSERT INTO agent_team_members (team_id, user_id) VALUES ('team-a', 1)", '23505'],
    ["INSERT INTO agent_teams (id, name) VALUES ('team-a', 'Duplicate')", '23505'],
    ["INSERT INTO agent_team_projects VALUES ('missing', 'team-a')", '23503'],
    ["INSERT INTO agent_team_projects VALUES ('teamless', 'missing')", '23503'],
    ["INSERT INTO agent_team_members (team_id, user_id) VALUES ('missing', 1)", '23503'],
    ["INSERT INTO agent_team_members (team_id, user_id) VALUES ('team-a', 999)", '23503'],
    ["UPDATE agent_teams SET state='invalid'", '23514'],
    ["UPDATE agent_team_members SET state='invalid'", '23514'],
    ['UPDATE agent_teams SET version=0', '23514'],
    ['UPDATE agent_teams SET version=-1', '23514'],
    ['UPDATE agent_teams SET version=NULL', '23502'],
    ['UPDATE agent_teams SET name=NULL', '23502'],
    ['UPDATE agent_teams SET state=NULL', '23502'],
    ['UPDATE agent_team_members SET state=NULL', '23502'],
    ["UPDATE agent_team_projects SET team_id=NULL WHERE project_id='agent-a'", '23502'],
  ])('enforces the schema: %s', async (sql, code) => {
    await expect(state.client!.query(sql)).rejects.toMatchObject({ code });
  });

  it.each([1, 2, 3])('resolves current eligible role for user %i without legacy Project membership inheritance', async (userId) => {
    await expect(resolveTeamAgentContext({ userId, agentProjectId: 'agent-a' })).resolves
      .toEqual({ agentProjectId: 'agent-a', teamId: 'team-a', userId });
  });

  it.each([4, 5, 6, 999])('rejects restricted, disabled or missing user %i', async (userId) => {
    await expect(resolveTeamAgentContext({ userId, agentProjectId: 'agent-a' })).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it.each([
    "UPDATE users SET disabled=1 WHERE id=1",
    "UPDATE users SET role='viewer' WHERE id=1",
    "UPDATE projects SET archived=1 WHERE id='agent-a'",
    "UPDATE project_agent_profiles SET status='disabled' WHERE project_id='agent-a'",
    "UPDATE project_agent_profiles SET status='pending' WHERE project_id='agent-a'",
    "UPDATE agent_teams SET state='disabled' WHERE id='team-a'",
    "UPDATE agent_team_members SET state='disabled' WHERE team_id='team-a' AND user_id=1",
  ])('rechecks current facts after revocation: %s', async (sql) => {
    await expect(resolveTeamAgentContext({ userId: 1, agentProjectId: 'agent-a' })).resolves.toMatchObject({ teamId: 'team-a' });
    await state.client!.query(sql);
    await expect(resolveTeamAgentContext({ userId: 1, agentProjectId: 'agent-a' })).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it.each(['pending', 'rejected', 'suspended'])('rejects user approval status %s in context and inventory', async (status) => {
    await state.client!.query('UPDATE users SET approval_status=$1 WHERE id=1', [status]);
    await expect(resolveTeamAgentContext({ userId: 1, agentProjectId: 'agent-a' })).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
    await expect(listCurrentTeamWorkspaces({ userId: 1, agentProjectId: 'agent-a' })).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it.each(['retiring', 'retired', 'purge_pending', 'purge_failed'])('rejects source lifecycle status %s in context and inventory', async (status) => {
    await state.client!.query("UPDATE projects SET lifecycle_status=$1 WHERE id='agent-a'", [status]);
    await expect(resolveTeamAgentContext({ userId: 1, agentProjectId: 'agent-a' })).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
    await expect(listCurrentTeamWorkspaces({ userId: 1, agentProjectId: 'agent-a' })).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it('rejects a team-assigned Agent with no current profile', async () => {
    await state.client!.query("DELETE FROM project_agent_profiles WHERE project_id='teamless'; INSERT INTO agent_team_projects VALUES ('teamless', 'team-a')");
    await expect(resolveTeamAgentContext({ userId: 1, agentProjectId: 'teamless' })).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it('accepts a ready Agent', async () => {
    await state.client!.query("UPDATE project_agent_profiles SET status='ready' WHERE project_id='agent-a'");
    await expect(resolveTeamAgentContext({ userId: 1, agentProjectId: 'agent-a' })).resolves.toMatchObject({ teamId: 'team-a' });
  });

  it('returns null only for an existing teamless Agent, not missing Agent or missing membership', async () => {
    await expect(resolveTeamAgentContext({ userId: 1, agentProjectId: 'teamless' })).resolves.toBeNull();
    await expect(resolveTeamAgentContext({ userId: 1, agentProjectId: 'missing' })).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
    await expect(resolveTeamAgentContext({ userId: 1, agentProjectId: 'agent-b' })).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
    // Admin/operator roles do not bypass explicit team membership either.
    await expect(resolveTeamAgentContext({ userId: 2, agentProjectId: 'agent-b' })).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
    await expect(resolveTeamAgentContext({ userId: 3, agentProjectId: 'agent-b' })).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it('lists only registered active workspaces in the source team, even for a multi-team user', async () => {
    await state.client!.query(`
      INSERT INTO agent_team_members (team_id, user_id) VALUES ('team-b', 1);
      INSERT INTO projects (id, name, archived) VALUES
        ('peer-ready', 'Ready', 0), ('peer-disabled', 'Disabled', 0), ('peer-archived', 'Archived', 1),
        ('workspace-disabled', 'Disabled workspace', 0), ('workspace-missing', 'No workspace', 0),
        ('profile-missing', 'No profile', 0);
      INSERT INTO project_agent_profiles (project_id, status) VALUES
        ('peer-ready', 'ready'), ('peer-disabled', 'disabled'), ('peer-archived', 'active'),
        ('workspace-disabled', 'active'), ('workspace-missing', 'active');
      INSERT INTO agent_team_projects (project_id, team_id) VALUES
        ('peer-ready', 'team-a'), ('peer-disabled', 'team-a'), ('peer-archived', 'team-a'),
        ('workspace-disabled', 'team-a'), ('workspace-missing', 'team-a'), ('profile-missing', 'team-a');
      INSERT INTO agent_workspaces (id, owner_project_id, kind, state) VALUES
        ('workspace-b', 'agent-b', 'project', 'active'), ('workspace-ready', 'peer-ready', 'project', 'active'),
        ('workspace-agent-disabled', 'peer-disabled', 'project', 'active'), ('workspace-archived', 'peer-archived', 'project', 'active'),
        ('workspace-disabled', 'workspace-disabled', 'project', 'disabled'),
        ('workspace-no-profile', 'profile-missing', 'project', 'active'), ('workspace-teamless', 'teamless', 'project', 'active');
    `);
    await expect(listCurrentTeamWorkspaces({ userId: 1, agentProjectId: 'agent-a' })).resolves.toEqual([
      { workspaceId: 'workspace-a', ownerProjectId: 'agent-a' },
      { workspaceId: 'workspace-ready', ownerProjectId: 'peer-ready' },
    ]);
    await expect(listCurrentTeamWorkspaces({ userId: 1, agentProjectId: 'agent-b' })).resolves.toEqual([
      { workspaceId: 'workspace-b', ownerProjectId: 'agent-b' },
    ]);
  });

  it.each(['retiring', 'retired', 'purge_pending', 'purge_failed'])('excludes target lifecycle status %s from inventory', async (status) => {
    await state.client!.query(`
      INSERT INTO projects (id, name) VALUES ('peer', 'Peer');
      INSERT INTO project_agent_profiles (project_id) VALUES ('peer');
      INSERT INTO agent_team_projects VALUES ('peer', 'team-a');
      INSERT INTO agent_workspaces (id, owner_project_id, kind) VALUES ('workspace-peer', 'peer', 'project');
    `);
    await expect(listCurrentTeamWorkspaces({ userId: 1, agentProjectId: 'agent-a' })).resolves.toHaveLength(2);
    await state.client!.query("UPDATE projects SET lifecycle_status=$1 WHERE id='peer'", [status]);
    await expect(listCurrentTeamWorkspaces({ userId: 1, agentProjectId: 'agent-a' })).resolves.toEqual([
      { workspaceId: 'workspace-a', ownerProjectId: 'agent-a' },
    ]);
  });

  it('distinguishes an empty team inventory from teamless or denied context', async () => {
    await state.client!.query("UPDATE agent_workspaces SET state='disabled' WHERE id='workspace-a'");
    await expect(listCurrentTeamWorkspaces({ userId: 1, agentProjectId: 'agent-a' })).resolves.toEqual([]);
    await expect(listCurrentTeamWorkspaces({ userId: 1, agentProjectId: 'teamless' })).resolves.toBeNull();
    await expect(listCurrentTeamWorkspaces({ userId: 1, agentProjectId: 'agent-b' })).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
    await state.client!.query("UPDATE agent_team_members SET state='disabled' WHERE user_id=1 AND team_id='team-a'");
    await expect(listCurrentTeamWorkspaces({ userId: 1, agentProjectId: 'agent-a' })).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it.each([
    "UPDATE agent_teams SET state='disabled' WHERE id='team-a'",
    "UPDATE project_agent_profiles SET status='disabled' WHERE project_id='agent-a'",
    "UPDATE projects SET archived=1 WHERE id='agent-a'",
    "UPDATE users SET disabled=1 WHERE id=1",
  ])('rejects inventory after source authority changes: %s', async (sql) => {
    await state.client!.query(sql);
    await expect(listCurrentTeamWorkspaces({ userId: 1, agentProjectId: 'agent-a' })).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it.each([
    "UPDATE users SET disabled=1 WHERE id=1",
    "UPDATE users SET approval_status='pending' WHERE id=1",
    "UPDATE projects SET archived=1 WHERE id='teamless'",
    "UPDATE projects SET lifecycle_status='retired' WHERE id='teamless'",
  ])('rejects invalid teamless current facts before legacy fallback: %s', async sql => {
    await state.client!.query(sql);
    await expect(resolveTeamAgentContext({ userId: 1, agentProjectId: 'teamless' })).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
    await expect(listCurrentTeamWorkspaces({ userId: 1, agentProjectId: 'teamless' })).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it.each([4, 5])('preserves teamless read-policy fallback for viewer/guest account %s without team admission', async userId => {
    expect(await resolveTeamAgentContext({ userId, agentProjectId: 'teamless' })).toBeNull();
    expect(await listCurrentTeamWorkspaces({ userId, agentProjectId: 'teamless' })).toBeNull();
    await expect(resolveTeamAgentContext({ userId, agentProjectId: 'agent-a' })).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it.each([
    "DELETE FROM project_agent_profiles WHERE project_id='teamless'",
    "UPDATE project_agent_profiles SET status='inactive' WHERE project_id='teamless'",
  ])('defers legacy teamless profile execution eligibility to the original caller: %s', async sql => {
    await state.client!.query(sql);
    expect(await resolveTeamAgentContext({ userId: 1, agentProjectId: 'teamless' })).toBeNull();
    expect(await listCurrentTeamWorkspaces({ userId: 1, agentProjectId: 'teamless' })).toBeNull();
  });

  it('the actual profile schema rejects NULL status before context can admit it', async () => {
    await expect(state.client!.query("UPDATE project_agent_profiles SET status=NULL WHERE project_id='teamless'"))
      .rejects.toMatchObject({ code: '23502' });
  });

  it('context admission is independent of an overflowing team inventory', async () => {
    await state.client!.query(`
      INSERT INTO projects (id,name) SELECT 'extra-' || n,'Extra' FROM generate_series(1,256) AS n;
      INSERT INTO project_agent_profiles (project_id) SELECT id FROM projects WHERE id LIKE 'extra-%';
      INSERT INTO agent_team_projects (project_id,team_id) SELECT id,'team-a' FROM projects WHERE id LIKE 'extra-%';
      INSERT INTO agent_workspaces (id,owner_project_id,kind) SELECT 'w-' || id,id,'project' FROM projects WHERE id LIKE 'extra-%';
    `);
    expect(await resolveTeamAgentContext({ userId: 1, agentProjectId: 'agent-a' }))
      .toEqual({ agentProjectId: 'agent-a', teamId: 'team-a', userId: 1 });
    await expect(listCurrentTeamWorkspaces({ userId: 1, agentProjectId: 'agent-a' })).rejects.toThrow('TEAM_WORKSPACE_INVENTORY_LIMIT');
  });

  it('does not treat unavailable database facts as a teamless Agent', async () => {
    // Only this disposable fixture transaction is altered; ROLLBACK restores it.
    await state.client!.query('ALTER TABLE agent_team_members RENAME TO unavailable_members');
    await expect(resolveTeamAgentContext({ userId: 1, agentProjectId: 'teamless' })).rejects.toMatchObject({ code: '42P01' });
  });
});
