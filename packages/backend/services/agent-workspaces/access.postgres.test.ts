/** Opt-in disposable PostgreSQL only. Never accepts the application's DB URL. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { afterAll, beforeAll, expect, it, vi, describe } from 'vitest';
import { isProjectMember } from '../pm/project-membership-manager.js';
import { requireAgentWorkspaceAccess } from './access.js';
import { requireCurrentAgentExecutionAccess } from '../authority/agent-execution-access.js';
import { setOrganizationExecutionAdmission } from '../authority/organization-execution-admission.js';
import { listAgentWorkspaceInventory } from './workspace-inventory.js';
const state = vi.hoisted(() => ({ client: null as any }));
vi.mock('../../db/pg-repo.js', () => ({ execute: async (sql: string, params: unknown[]) => state.client.query(sql, params), query: async (sql: string, params: unknown[]) => (await state.client.query(sql, params)).rows, queryOne: async (sql: string, params: unknown[]) => (await state.client.query(sql, params)).rows[0] ?? null }));
const bin = '/usr/lib/postgresql/18/bin';
let root: string;
let started = false;
describe.skipIf(process.env.AGENT_WORKSPACE_PG_TEST !== '1')('disposable PostgreSQL authority', () => {
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(process.cwd(), 'work/agent-pg-'));
    await fs.chmod(root, 0o700);
    execFileSync(`${bin}/initdb`, ['-D', `${root}/data`, '-A', 'trust', '--no-locale'], { stdio: 'ignore' });
    execFileSync(`${bin}/pg_ctl`, ['-D', `${root}/data`, '-l', `${root}/postgres.log`, '-o', `-k ${root} -h '' -p 55439`, '-w', 'start'], { stdio: 'ignore' });
    started = true;
    state.client = new Client({ host: root, port: 55439, database: 'postgres', user: process.env.USER });
    await state.client.connect();
    await state.client.query(`CREATE TABLE users(id integer PRIMARY KEY, role text, disabled integer);
      CREATE TABLE projects(id text PRIMARY KEY, root_path text, archived integer);
      CREATE TABLE project_members(project_id text, user_id integer, role text);
      CREATE TABLE project_agent_profiles(project_id text, status text);
      CREATE TABLE app_settings(key text PRIMARY KEY, value jsonb NOT NULL, updated_by integer, updated_at timestamptz);`);
    for (const file of ['195_project_file_storage_bindings.sql', '196_agent_workspace_grants.sql']) {
      const sql = await fs.readFile(path.join(process.cwd(), 'packages/backend/db/migrations', file), 'utf8');
      await state.client.query(sql); await state.client.query(sql);
    }
    await state.client.query(`INSERT INTO users VALUES (1,'member',0);
      INSERT INTO projects VALUES ('a','/fixture/a',0),('b','/fixture/b',0),('c','/fixture/c',0);
      INSERT INTO project_members VALUES ('a',1,'member');
      INSERT INTO project_agent_profiles VALUES ('a','active');
      INSERT INTO agent_workspaces(id,owner_project_id,kind) VALUES ('wa','a','project'),('wb','b','project'),('wc','c','project');
      INSERT INTO agent_workspace_grants(agent_project_id,workspace_id,mode) VALUES ('a','wb','read'),('b','wc','read-write');`);
  }, 30000);
  afterAll(async () => {
    if (state.client) await state.client.end();
    if (started) execFileSync(`${bin}/pg_ctl`, ['-D', `${root}/data`, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  it('executes the real SQL for own and connected workspace permissions', async () => {
    expect(await requireAgentWorkspaceAccess({ userId: 1, agentProjectId: 'a', workspaceId: 'wa', operation: 'write' })).toMatchObject({ ownWorkspace: true });
    expect(await requireAgentWorkspaceAccess({ userId: 1, agentProjectId: 'a', workspaceId: 'wb', operation: 'read' })).toMatchObject({ mode: 'read', grantVersion: 1 });
    await expect(requireAgentWorkspaceAccess({ userId: 1, agentProjectId: 'a', workspaceId: 'wb', operation: 'write' })).rejects.toThrow('READ_ONLY');
    await expect(requireAgentWorkspaceAccess({ userId: 1, agentProjectId: 'a', workspaceId: 'wc', operation: 'read' })).rejects.toThrow('NOT_GRANTED');
  });
  it('lists only own and directly granted workspaces using real SQL', async () => {
    const inventory = await listAgentWorkspaceInventory({ userId: 1, agentProjectId: 'a' });
    expect(inventory.map(item => item.workspaceId)).toEqual(['wa', 'wb']);
    expect(inventory.map(item => item.readOnly)).toEqual([false, true]);
  });
  it('observes a committed revocation', async () => {
    await state.client.query("UPDATE agent_workspace_grants SET revoked_at=NOW() WHERE agent_project_id='a'");
    await expect(requireAgentWorkspaceAccess({ userId: 1, agentProjectId: 'a', workspaceId: 'wb', operation: 'read' })).rejects.toThrow('NOT_GRANTED');
  });
  it('rejects retired organization scope and never writes an admission setting', async () => {
    await expect(requireCurrentAgentExecutionAccess({ projectId: 'a', userId: 1, executionScope: 'organization' })).rejects.toThrow('EXECUTION_SCOPE_UNSUPPORTED');
    await expect(setOrganizationExecutionAdmission({ actorUserId: 1, targetUserId: 1, allowed: true })).rejects.toThrow('ORGANIZATION_ADMISSION_RETIRED');
    expect((await state.client.query('SELECT count(*)::int AS count FROM app_settings')).rows[0].count).toBe(0);
  });

  it('uses actual current membership role for writes while preserving read access', async () => {
    await state.client.query("INSERT INTO users VALUES (9,'member',0); INSERT INTO project_members VALUES ('a',9,'viewer')");
    expect(await isProjectMember('a', 9)).toBe(true);
    expect(await isProjectMember('a', 9, 'write')).toBe(false);
    await state.client.query("UPDATE project_members SET role='member' WHERE user_id=9");
    expect(await isProjectMember('a', 9, 'write')).toBe(true);
    await state.client.query("UPDATE users SET role='viewer' WHERE id=9");
    expect(await isProjectMember('a', 9, 'write')).toBe(false);
    await state.client.query('UPDATE users SET disabled=1 WHERE id=9');
    expect(await isProjectMember('a', 9)).toBe(false);
  });

});
