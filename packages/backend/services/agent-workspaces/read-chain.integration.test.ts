/** Real service chain and filesystem; DB facts/session visibility/Worker transport are fixtures. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { query, queryOne } from '../../db/pg-repo.js';
import { readSessionAgentWorkspaceFile } from './session-read.js';
import { replaceAgentWorkspaceText } from './write-file.js';
import { readProjectWorkspaceFileBytes, resolveProjectWorkspaceFile } from '../project-environment/project-workspace-files.js';
vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock('../pm/project-access.js', () => ({ canAccessSession: vi.fn(async () => ({ allowed: true })) }));
vi.mock('../auth/auth.js', () => ({ getUserAuthState: vi.fn(async () => ({ disabled: false, approvalStatus: 'active', role: 'member' })) }));
vi.mock('../project-environment/project-environment-deployment.js', () => ({ resolveProjectEnvironmentDeploymentId: () => 'test' }));
vi.mock('../project-environment/adapters/legacy-project-compute-adapter.js', () => ({ readLegacyProjectComputePlacement: vi.fn(() => { throw new Error('unexpected compute fallback'); }) }));
vi.mock('../runtime-box/workbench-project-file-authority.js', () => ({ resolveWorkerFileAuthorityForHostPath: vi.fn(), downloadWorkerProjectFile: vi.fn(), compareAndSwapWorkerProjectFile: vi.fn() }));
let root: string;
let mode: string | null;
let revoked: string | null;
let storageState: string;
let targetMember: boolean;
const ref = { agentProjectId: 'a', workspaceId: 'b-files', relativePath: 'index.html' };
const read = () => readSessionAgentWorkspaceFile({ userId: 1, sessionId: 's', body: { ref } });
beforeEach(() => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chain-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>원본</h1>');
  mode = 'read'; revoked = null; storageState = 'ready'; targetMember = false;
  vi.mocked(queryOne).mockImplementation(async (sql: string) => {
    if (sql.includes('FROM users WHERE')) return { role: 'member', disabled: 0 } as any;
    if (sql.includes('FROM sessions')) return { project_id: 'a' } as any;
    if (sql.includes('FROM projects p')) return { id: 'b', root_path: root, user_id: 2 } as any;
    if (sql.includes('FROM project_members pm JOIN users u')) return targetMember ? { 1: 1 } as any : undefined;
    if (sql.includes('JOIN agent_workspaces')) return {
      user_role: 'member', user_disabled: 0, agent_archived: 0, agent_status: 'active', membership_role: 'member',
      workspace_state: 'active', workspace_kind: 'project', owner_project_id: 'b', owner_root_path: root, owner_archived: 0,
      grant_mode: mode, grant_version: 1, grant_revoked_at: revoked,
    } as any;
    throw new Error('Unexpected queryOne');
  });
  vi.mocked(query).mockImplementation(async (sql: string) => {
    if (sql.includes('FROM projects')) return [{ id: 'b', root_path: root }] as any;
    if (sql.includes('FROM project_file_storage_bindings')) return [{ project_id: 'b', deployment_id: 'test', storage_kind: 'host', worker_id: null, state: storageState, version: 1 }] as any;
    throw new Error('Unexpected query');
  });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it('reads connected read-only workspace bytes across the whole internal chain', async () => {
  expect((await read()).bytes.toString()).toBe('<h1>원본</h1>');
});
it('rejects writes to a read-only connection and leaves bytes intact', async () => {
  await expect(replaceAgentWorkspaceText({ userId: 1, trustedAgentProjectId: 'a', ref, expectedContent: '<h1>원본</h1>', content: 'changed' })).rejects.toThrow('READ_ONLY');
  expect(fs.readFileSync(path.join(root, 'index.html'), 'utf8')).toBe('<h1>원본</h1>');
});
it('writes through an explicit read-write connection and reads the same bytes', async () => {
  mode = 'read-write';
  await replaceAgentWorkspaceText({ userId: 1, trustedAgentProjectId: 'a', ref, expectedContent: '<h1>원본</h1>', content: 'changed' });
  expect((await read()).bytes.toString()).toBe('changed');
}, 15_000); // Real filesystem publication can exceed Vitest's 5s default under full-suite contention.
it('observes revocation on the next read rather than caching earlier permission', async () => {
  await read(); revoked = '2026-01-01';
  await expect(read()).rejects.toThrow('NOT_GRANTED');
});
it('rejects a missing direct connection before discovering storage', async () => {
  mode = null;
  await expect(read()).rejects.toThrow('NOT_GRANTED');
  expect(query).not.toHaveBeenCalled();
});
it('does not use a readable host file when explicit storage is blocked', async () => {
  storageState = 'blocked';
  await expect(read()).rejects.toThrow('STORAGE_NOT_READY');
});

it('does not delegate Agent grants to direct Project access', async () => {
  const reference = await resolveProjectWorkspaceFile({ projectId: 'b', projectRoot: root, relativePath: 'index.html' });
  await expect(readProjectWorkspaceFileBytes({ reference, actorUserId: 1, maxBytes: 1024 })).rejects.toThrow('PROJECT_FILE_SOURCE_ACCESS_REVOKED');
});
it('does not substitute target membership for a missing direct grant', async () => {
  targetMember = true; mode = null;
  await expect(read()).rejects.toThrow('NOT_GRANTED');
});
