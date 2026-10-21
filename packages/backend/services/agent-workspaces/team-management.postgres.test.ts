/** Disposable PostgreSQL only. No application DB URL or production migration. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTeamManagement, previewTeamManagement, type TeamManagementCommand } from './team-management.js';
import { createTeamManagementIntent, applyTeamManagementIntent } from './team-management-intent.js';
let pool: Pool;
let root: string | undefined;
let started = false;
const bin = '/usr/lib/postgresql/18/bin';
vi.mock('../../db/pg-repo.js', () => ({ transaction: async (fn: (client: PoolClient) => Promise<unknown>) => {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
} }));
const preview = (command: TeamManagementCommand) => previewTeamManagement({ actorUserId: 1, command });
const execute = async (command: TeamManagementCommand) => applyTeamManagement({ actorUserId: 1, preview: await preview(command), confirmed: true });

describe.skipIf(process.env.TEAM_MANAGEMENT_PG_TEST !== '1')('team management disposable PostgreSQL', () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.resolve('work/team-management-pg-'));
    execFileSync(`${bin}/initdb`, ['-D', `${root}/data`, '-A', 'trust', '-U', 'fixture', '--no-locale'], { stdio: 'pipe' });
    execFileSync(`${bin}/pg_ctl`, ['-D', `${root}/data`, '-l', `${root}/postgres.log`, '-o', `-h '' -k '${root}' -p 55449`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    pool = new Pool({ host: root, port: 55449, user: 'fixture', database: 'postgres', max: 4 });
    for (const migration of ['007_users.sql', '008_sessions.sql', '009_projects.sql', '091_signup_invite_codes.sql', '107_project_agent_profiles.sql', '163_project_agent_lifecycle.sql', '196_agent_workspace_grants.sql', '236_agent_teams.sql', '237_team_management_intents.sql']) {
      await pool.query(fs.readFileSync(path.resolve('packages/backend/db/migrations', migration), 'utf8'));
    }
    await pool.query('CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT); CREATE TABLE fixture_credentials (id TEXT PRIMARY KEY,value TEXT)');
  }, 60000);
  afterAll(async () => {
    if (pool) await pool.end();
    if (root && started) execFileSync(`${bin}/pg_ctl`, ['-D', `${root}/data`, '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }, 30000);
  beforeEach(async () => {
    await pool.query(`TRUNCATE users,projects,agent_teams,sessions,app_settings,fixture_credentials CASCADE;
      INSERT INTO users (id,username,password_hash,role) VALUES (1,'admin','synthetic','admin'),(2,'member','synthetic','member'),(3,'operator','synthetic','operator'),(4,'viewer','synthetic','viewer'),(5,'guest','synthetic','viewer');
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
      UPDATE users SET role='guest' WHERE id=5;
      INSERT INTO projects (id,name) VALUES ('a','Agent'),('b','Other');
      INSERT INTO project_agent_profiles (project_id) VALUES ('a'),('b');
      INSERT INTO agent_workspaces (id,owner_project_id,kind) VALUES ('wa','a','project');
      INSERT INTO agent_teams (id,name) VALUES ('ta','Team A'),('tb','Team B');
      INSERT INTO sessions (id,name,user_id,project_id) VALUES ('private','Private',2,'a');
      INSERT INTO app_settings VALUES ('execution.organization-admission.2','true');
      INSERT INTO fixture_credentials VALUES ('credential','synthetic');`);
  });

  it('server-stores exact preview, applies once, and leaves a consumed receipt', async () => {
    const command = { kind: 'invite', teamId: 'ta', userId: 2 } as const;
    const intent = await createTeamManagementIntent({ actorUserId: 1, command });
    expect(intent.preview.command).toEqual(command);
    // Browser mutation is not authoritative: apply accepts identifiers only.
    intent.preview.command.teamId = 'tb';
    const input = { actorUserId: 1, intentId: intent.intentId, proposalHash: intent.proposalHash, confirmed: true };
    expect(await applyTeamManagementIntent(input)).toEqual({ changed: true, teamVersion: 2 });
    expect((await pool.query('SELECT team_id FROM agent_team_members')).rows).toEqual([{ team_id: 'ta' }]);
    await expect(applyTeamManagementIntent(input)).rejects.toThrow('INTENT_CONSUMED');
    const receipt = (await pool.query('SELECT actor_user_id,consumed_at,result FROM team_management_intents WHERE id=$1', [intent.intentId])).rows[0];
    expect(receipt.actor_user_id).toBe(1);
    expect(receipt.consumed_at).not.toBeNull();
    expect(receipt.result).toEqual({ changed: true, teamVersion: 2 });
  });

  it('binds actor/hash and explicit confirmation without consuming rejected intents', async () => {
    const intent = await createTeamManagementIntent({ actorUserId: 1, command: { kind: 'invite', teamId: 'ta', userId: 2 } });
    await pool.query("UPDATE users SET role='admin' WHERE id=3");
    const input = { actorUserId: 1, intentId: intent.intentId, proposalHash: intent.proposalHash, confirmed: true };
    await expect(applyTeamManagementIntent({ ...input, actorUserId: 3 })).rejects.toThrow('INTENT_BINDING');
    await expect(applyTeamManagementIntent({ ...input, proposalHash: '0'.repeat(64) })).rejects.toThrow('INTENT_BINDING');
    await expect(applyTeamManagementIntent({ ...input, confirmed: false })).rejects.toThrow('CONFIRMATION_REQUIRED');
    expect((await pool.query('SELECT consumed_at FROM team_management_intents WHERE id=$1', [intent.intentId])).rows[0].consumed_at).toBeNull();
    expect((await applyTeamManagementIntent(input)).changed).toBe(true);
  });

  it('rejects expired and unknown intents', async () => {
    const intent = await createTeamManagementIntent({ actorUserId: 1, command: { kind: 'invite', teamId: 'ta', userId: 2 } });
    await pool.query("UPDATE team_management_intents SET expires_at=now()-interval '1 second' WHERE id=$1", [intent.intentId]);
    await expect(applyTeamManagementIntent({ actorUserId: 1, ...intent, confirmed: true })).rejects.toThrow('INTENT_EXPIRED');
    await expect(applyTeamManagementIntent({ actorUserId: 1, ...intent, intentId: '7ee5d233-e4d6-43df-bcda-ad4991033045', confirmed: true })).rejects.toThrow('INTENT_NOT_FOUND');
    expect((await pool.query('SELECT * FROM agent_team_members')).rows).toEqual([]);
  });

  it('serializes concurrent replay and applies exactly once', async () => {
    const intent = await createTeamManagementIntent({ actorUserId: 1, command: { kind: 'invite', teamId: 'ta', userId: 2 } });
    const input = { actorUserId: 1, intentId: intent.intentId, proposalHash: intent.proposalHash, confirmed: true };
    const results = await Promise.allSettled([applyTeamManagementIntent(input), applyTeamManagementIntent(input)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.message).toContain('INTENT_CONSUMED');
    expect((await pool.query("SELECT version FROM agent_teams WHERE id='ta'")).rows[0].version).toBe(2);
  });

  it('rolls back consumption on stale version and current admin revocation', async () => {
    const intent = await createTeamManagementIntent({ actorUserId: 1, command: { kind: 'invite', teamId: 'ta', userId: 2 } });
    await execute({ kind: 'invite', teamId: 'ta', userId: 3 });
    await expect(applyTeamManagementIntent({ actorUserId: 1, ...intent, confirmed: true })).rejects.toThrow('PREVIEW_STALE');
    expect((await pool.query('SELECT consumed_at FROM team_management_intents WHERE id=$1', [intent.intentId])).rows[0].consumed_at).toBeNull();
    const second = await createTeamManagementIntent({ actorUserId: 1, command: { kind: 'invite', teamId: 'ta', userId: 2 } });
    await pool.query('UPDATE users SET disabled=1 WHERE id=1');
    await expect(applyTeamManagementIntent({ actorUserId: 1, ...second, confirmed: true })).rejects.toThrow('ADMIN_REQUIRED');
    expect((await pool.query('SELECT consumed_at FROM team_management_intents WHERE id=$1', [second.intentId])).rows[0].consumed_at).toBeNull();
    expect((await pool.query('SELECT user_id FROM agent_team_members')).rows).toEqual([{ user_id: 3 }]);
  });

  it('rejects tampered server-stored previews whose canonical hash no longer matches', async () => {
    const intent = await createTeamManagementIntent({ actorUserId: 1, command: { kind: 'invite', teamId: 'ta', userId: 2 } });
    await pool.query(`UPDATE team_management_intents SET preview=jsonb_set(preview,'{command,teamId}','"tb"') WHERE id=$1`, [intent.intentId]);
    await expect(applyTeamManagementIntent({ actorUserId: 1, ...intent, confirmed: true })).rejects.toThrow('INTENT_BINDING');
    expect((await pool.query('SELECT * FROM agent_team_members')).rows).toEqual([]);
  });

  it('rolls back the management write if expiry passes while waiting for the team lock', async () => {
    const intent = await createTeamManagementIntent({ actorUserId: 1, command: { kind: 'invite', teamId: 'ta', userId: 2 } });
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query("SELECT id FROM agent_teams WHERE id='ta' FOR UPDATE");
      await pool.query("UPDATE team_management_intents SET expires_at=clock_timestamp()+interval '0.15 seconds' WHERE id=$1", [intent.intentId]);
      const rejection = expect(applyTeamManagementIntent({ actorUserId: 1, ...intent, confirmed: true })).rejects.toThrow('INTENT_EXPIRED');
      await blocker.query('SELECT pg_sleep(0.3)');
      await blocker.query('COMMIT');
      await rejection;
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    expect((await pool.query('SELECT * FROM agent_team_members')).rows).toEqual([]);
    expect((await pool.query("SELECT version FROM agent_teams WHERE id='ta'")).rows[0].version).toBe(1);
    expect((await pool.query('SELECT consumed_at FROM team_management_intents WHERE id=$1', [intent.intentId])).rows[0].consumed_at).toBeNull();
  });

  it('rolls back assignment approval consumption when confirmed workspace scope changes', async () => {
    const intent = await createTeamManagementIntent({ actorUserId: 1, command: { kind: 'assign', teamId: 'ta', projectId: 'b' } });
    await pool.query("INSERT INTO agent_workspaces (id,owner_project_id,kind) VALUES ('wb','b','project')");
    await expect(applyTeamManagementIntent({ actorUserId: 1, ...intent, confirmed: true })).rejects.toThrow('PREVIEW_STALE');
    expect((await pool.query('SELECT * FROM agent_team_projects')).rows).toEqual([]);
    expect((await pool.query('SELECT consumed_at FROM team_management_intents WHERE id=$1', [intent.intentId])).rows[0].consumed_at).toBeNull();
  });

  it('consumes even idempotent no-op approval to prevent replay', async () => {
    await execute({ kind: 'invite', teamId: 'ta', userId: 2 });
    const intent = await createTeamManagementIntent({ actorUserId: 1, command: { kind: 'invite', teamId: 'ta', userId: 2 } });
    const input = { actorUserId: 1, ...intent, confirmed: true };
    expect(await applyTeamManagementIntent(input)).toEqual({ changed: false, teamVersion: 2 });
    await expect(applyTeamManagementIntent(input)).rejects.toThrow('INTENT_CONSUMED');
  });

  it('intent migration is repeatable and account deletion removes only its approval receipts', async () => {
    const migration = fs.readFileSync(path.resolve('packages/backend/db/migrations/237_team_management_intents.sql'), 'utf8');
    await pool.query(migration);
    await pool.query(migration);
    const intent = await createTeamManagementIntent({ actorUserId: 1, command: { kind: 'create', teamId: 'new', name: 'New' } });
    await pool.query('DELETE FROM users WHERE id=1');
    expect((await pool.query('SELECT * FROM team_management_intents WHERE id=$1', [intent.intentId])).rows).toEqual([]);
    expect((await pool.query('SELECT * FROM agent_teams')).rows).toHaveLength(2);
  });

  it('previews without writes, creates a team only with explicit confirmation', async () => {
    const plan = await preview({ kind: 'create', teamId: 'new', name: 'New Team' });
    expect((await pool.query("SELECT * FROM agent_teams WHERE id='new'")).rows).toEqual([]);
    await expect(applyTeamManagement({ actorUserId: 1, preview: plan, confirmed: false })).rejects.toThrow('CONFIRMATION_REQUIRED');
    expect(await applyTeamManagement({ actorUserId: 1, preview: plan, confirmed: true })).toEqual({ changed: true, teamVersion: 1 });
  });

  it.each([
    "UPDATE users SET role='operator' WHERE id=1",
    'UPDATE users SET disabled=1 WHERE id=1',
    "UPDATE users SET approval_status='pending' WHERE id=1",
  ])('rechecks admin at apply after preview: %s', async sql => {
    const plan = await preview({ kind: 'invite', teamId: 'ta', userId: 2 });
    await pool.query(sql);
    await expect(applyTeamManagement({ actorUserId: 1, preview: plan, confirmed: true })).rejects.toThrow('ADMIN_REQUIRED');
    expect((await pool.query('SELECT * FROM agent_team_members')).rows).toEqual([]);
  });

  it('waits for an in-flight actor revocation then rejects apply against the committed current account', async () => {
    const plan = await preview({ kind: 'invite', teamId: 'ta', userId: 2 });
    const revoker = await pool.connect();
    try {
      await revoker.query('BEGIN');
      await revoker.query('UPDATE users SET disabled=1 WHERE id=1');
      const applying = applyTeamManagement({ actorUserId: 1, preview: plan, confirmed: true });
      const assertion = expect(applying).rejects.toThrow('ADMIN_REQUIRED');
      await revoker.query('COMMIT');
      await assertion;
      expect((await pool.query('SELECT * FROM agent_team_members')).rows).toEqual([]);
    } finally { await revoker.query('ROLLBACK'); revoker.release(); }
  });

  it('rejects create preview when its exact team ID was created in the meantime', async () => {
    const plan = await preview({ kind: 'create', teamId: 'new', name: 'New' });
    await pool.query("INSERT INTO agent_teams (id,name) VALUES ('new','Other')");
    await expect(applyTeamManagement({ actorUserId: 1, preview: plan, confirmed: true })).rejects.toThrow('TEAM_EXISTS');
    expect((await pool.query("SELECT name FROM agent_teams WHERE id='new'")).rows[0].name).toBe('Other');
  });

  it('serializes concurrent creates of the same absent team and reports a typed conflict', async () => {
    const command = { kind: 'create', teamId: 'new', name: 'New' } as const;
    const plans = await Promise.all([preview(command), preview(command)]);
    const results = await Promise.allSettled(plans.map(plan => applyTeamManagement({ actorUserId: 1, preview: plan, confirmed: true })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.message)
      .toContain('TEAM_MANAGEMENT_TEAM_EXISTS');
    expect((await pool.query("SELECT count(*)::int AS count FROM agent_teams WHERE id='new'")).rows[0].count).toBe(1);
  });

  it.each([1, 3])('explicitly allows active approved admin/operator invitee %s without changing their role', async userId => {
    const before = (await pool.query('SELECT role FROM users WHERE id=$1', [userId])).rows[0].role;
    expect((await execute({ kind: 'invite', teamId: 'ta', userId })).changed).toBe(true);
    expect((await pool.query('SELECT role FROM users WHERE id=$1', [userId])).rows[0].role).toBe(before);
  });

  it('invites/revokes/reactivates exactly one member and increments team version, active invite is idempotent', async () => {
    expect(await execute({ kind: 'invite', teamId: 'ta', userId: 2 })).toEqual({ changed: true, teamVersion: 2 });
    expect(await execute({ kind: 'invite', teamId: 'ta', userId: 2 })).toEqual({ changed: false, teamVersion: 2 });
    expect(await execute({ kind: 'revoke', teamId: 'ta', userId: 2 })).toEqual({ changed: true, teamVersion: 3 });
    expect(await execute({ kind: 'revoke', teamId: 'ta', userId: 2 })).toEqual({ changed: false, teamVersion: 3 });
    expect(await execute({ kind: 'invite', teamId: 'ta', userId: 2 })).toEqual({ changed: true, teamVersion: 4 });
    expect((await pool.query('SELECT team_id,user_id,state FROM agent_team_members')).rows).toEqual([{ team_id: 'ta', user_id: 2, state: 'active' }]);
  });

  it.each([4, 5])('does not invite viewer/guest %s', async userId => {
    await expect(preview({ kind: 'invite', teamId: 'ta', userId })).rejects.toThrow('INVITEE_INELIGIBLE');
  });

  it.each([
    'UPDATE users SET disabled=1 WHERE id=2',
    "UPDATE users SET approval_status='pending' WHERE id=2",
    "UPDATE users SET role='viewer' WHERE id=2",
  ])('rechecks invitee eligibility after preview: %s', async sql => {
    const plan = await preview({ kind: 'invite', teamId: 'ta', userId: 2 });
    await pool.query(sql);
    await expect(applyTeamManagement({ actorUserId: 1, preview: plan, confirmed: true })).rejects.toThrow('INVITEE_INELIGIBLE');
  });

  it('rejects stale version and permits only one of concurrent approved changes', async () => {
    const first = await preview({ kind: 'invite', teamId: 'ta', userId: 2 });
    const second = await preview({ kind: 'invite', teamId: 'ta', userId: 3 });
    const outcomes = await Promise.allSettled([first, second].map(plan => applyTeamManagement({ actorUserId: 1, preview: plan, confirmed: true })));
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    const failure = outcomes.find(item => item.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason.message).toContain('PREVIEW_STALE');
    expect((await pool.query('SELECT * FROM agent_team_members')).rows).toHaveLength(1);
  });

  it('rejects exact membership state drift even if an external writer omitted version bump', async () => {
    const plan = await preview({ kind: 'invite', teamId: 'ta', userId: 2 });
    await pool.query("INSERT INTO agent_team_members VALUES ('ta',2,'disabled')");
    await expect(applyTeamManagement({ actorUserId: 1, preview: plan, confirmed: true })).rejects.toThrow('PREVIEW_STALE');
  });

  it('previews file-sharing expansion, assigns once, and treats same-team assignment as idempotent', async () => {
    const plan = await preview({ kind: 'assign', teamId: 'ta', projectId: 'a' });
    expect(plan.expected.workspaceIds).toEqual(['wa']);
    expect(plan.warnings.join(' ')).toMatch(/file|workspace/i);
    expect(await applyTeamManagement({ actorUserId: 1, preview: plan, confirmed: true })).toEqual({ changed: true, teamVersion: 2 });
    expect(await execute({ kind: 'assign', teamId: 'ta', projectId: 'a' })).toEqual({ changed: false, teamVersion: 2 });
    await expect(preview({ kind: 'assign', teamId: 'tb', projectId: 'a' })).rejects.toThrow('REASSIGNMENT_REQUIRES_MIGRATION');
  });

  it('rejects workspace expansion or target assignment changes after preview', async () => {
    const plan = await preview({ kind: 'assign', teamId: 'ta', projectId: 'b' });
    await pool.query("INSERT INTO agent_workspaces (id,owner_project_id,kind) VALUES ('wb','b','project')");
    await expect(applyTeamManagement({ actorUserId: 1, preview: plan, confirmed: true })).rejects.toThrow('PREVIEW_STALE');
    const second = await preview({ kind: 'assign', teamId: 'ta', projectId: 'b' });
    await pool.query("INSERT INTO agent_team_projects VALUES ('b','tb')");
    await expect(applyTeamManagement({ actorUserId: 1, preview: second, confirmed: true })).rejects.toThrow('REASSIGNMENT_REQUIRES_MIGRATION');
  });

  it.each([
    "UPDATE agent_teams SET state='disabled' WHERE id='ta'",
    "UPDATE projects SET archived=1 WHERE id='a'",
    "UPDATE projects SET lifecycle_status='retired' WHERE id='a'",
    "DELETE FROM project_agent_profiles WHERE project_id='a'",
  ])('rechecks team and Agent state after assignment preview: %s', async sql => {
    const plan = await preview({ kind: 'assign', teamId: 'ta', projectId: 'a' });
    await pool.query(sql);
    await expect(applyTeamManagement({ actorUserId: 1, preview: plan, confirmed: true })).rejects.toThrow();
  });

  it('does not mutate private Sessions, Project membership, grants, credentials, settings or storage records', async () => {
    const snapshot = async () => (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(s)) FROM sessions s) AS sessions,
      (SELECT jsonb_agg(to_jsonb(m)) FROM project_members m) AS members,
      (SELECT jsonb_agg(to_jsonb(g)) FROM agent_workspace_grants g) AS grants,
      (SELECT jsonb_agg(to_jsonb(c)) FROM fixture_credentials c) AS credentials,
      (SELECT jsonb_agg(to_jsonb(a)) FROM app_settings a) AS settings,
      (SELECT jsonb_agg(to_jsonb(w)) FROM agent_workspaces w) AS workspaces,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM projects p) AS projects`)).rows[0];
    const before = await snapshot();
    await execute({ kind: 'create', teamId: 'new', name: 'New' });
    await execute({ kind: 'invite', teamId: 'ta', userId: 2 });
    await execute({ kind: 'assign', teamId: 'ta', projectId: 'a' });
    await execute({ kind: 'revoke', teamId: 'ta', userId: 2 });
    expect(await snapshot()).toEqual(before);
  });
});
