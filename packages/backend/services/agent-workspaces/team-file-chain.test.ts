/** Real FileRef/team policy/read-write/storage chain and filesystem; DB/Worker transport are fixtures.
 * No operating DB, public route, mount enforcement or executor activation is tested.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { query, queryOne } from '../../db/pg-repo.js';
import { readAgentWorkspaceFile } from './read-file.js';
import { replaceAgentWorkspaceText } from './write-file.js';
import { readProjectWorkspaceFileBytes, resolveProjectWorkspaceFile } from '../project-environment/project-workspace-files.js';
import { resolveWorkerFileAuthorityForHostPath, downloadWorkerProjectFile, compareAndSwapWorkerProjectFile } from '../runtime-box/workbench-project-file-authority.js';
vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock('../auth/auth.js', () => ({ getUserAuthState: vi.fn(async () => ({ disabled: false, approvalStatus: 'active', role: 'member' })) }));
vi.mock('../project-environment/project-environment-deployment.js', () => ({ resolveProjectEnvironmentDeploymentId: () => 'test' }));
vi.mock('../project-environment/adapters/legacy-project-compute-adapter.js', () => ({ readLegacyProjectComputePlacement: vi.fn(() => { throw new Error('unexpected compute fallback'); }) }));
vi.mock('../runtime-box/workbench-project-file-authority.js', () => ({ resolveWorkerFileAuthorityForHostPath: vi.fn(), downloadWorkerProjectFile: vi.fn(), compareAndSwapWorkerProjectFile: vi.fn() }));
let root: string;
let member: boolean;
let teamId: string | null;
let workspacePresent: boolean;
let teamQueries: number;
let afterTeamSnapshot: ((count: number) => void) | undefined;
let afterStorageSnapshot: ((count: number) => void) | undefined;
let storageQueries: number;
let storageKind: 'host' | 'worker';
let workerId: string | null;
let nested: boolean;
const ref = { agentProjectId: 'a', workspaceId: 'b-files', relativePath: 'index.html' };
const request = { userId: 1, trustedAgentProjectId: 'a', ref };
const before = '<h1>원본</h1>';
const read = (extra = {}) => readAgentWorkspaceFile({ ...request, ...extra });
const write = (extra = {}) => replaceAgentWorkspaceText({ ...request, expectedContent: before, content: 'changed', ...extra });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '1');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-file-chain-'));
  fs.writeFileSync(path.join(root, 'index.html'), before);
  member = true; teamId = 'team-a'; workspacePresent = true; teamQueries = 0;
  storageQueries = 0; storageKind = 'host'; workerId = null; nested = false;
  afterTeamSnapshot = undefined; afterStorageSnapshot = undefined;
  vi.mocked(queryOne).mockImplementation(async (sql: string) => {
    if (sql.includes('WITH active_agents')) {
      const snapshot = { user_active: true, user_role: 'member', agent_active: true, team_id: teamId, team_member: member,
        workspaces: workspacePresent && teamId !== null ? [{ workspaceId: 'b-files', ownerProjectId: 'b', teamId, registered: true, active: true }] : [] };
      afterTeamSnapshot?.(++teamQueries);
      return snapshot as any;
    }
    if (sql.includes('FROM projects p')) return { id: 'b', root_path: root, user_id: 2 } as any;
    if (sql.includes('FROM project_members pm JOIN users u')) return undefined;
    throw new Error(`Unexpected queryOne (legacy membership/grant must not be needed): ${sql}`);
  });
  vi.mocked(query).mockImplementation(async (sql: string) => {
    if (sql.includes('FROM projects')) return [
      ...(nested ? [{ id: 'nested', root_path: path.join(root, 'child') }] : []), { id: 'b', root_path: root },
    ] as any;
    if (sql.includes('FROM project_file_storage_bindings')) {
      const snapshot = [{ project_id: 'b', deployment_id: 'test', storage_kind: storageKind, worker_id: workerId, state: 'ready', version: 1 }];
      afterStorageSnapshot?.(++storageQueries);
      return snapshot as any;
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
it('reads and writes with only current team membership and no Project member or direct grant', async () => {
  expect((await read()).bytes.toString()).toBe(before);
  await write();
  expect((await read()).bytes.toString()).toBe('changed');
  expect(vi.mocked(queryOne).mock.calls.some(([sql]) => /project_members|agent_workspace_grants|INSERT|UPDATE/.test(sql))).toBe(false);
});
it('does not delegate team admission to direct Project file access', async () => {
  const reference = await resolveProjectWorkspaceFile({ projectId: 'b', projectRoot: root, relativePath: 'index.html' });
  await expect(readProjectWorkspaceFileBytes({ reference, actorUserId: 1, maxBytes: 1024 })).rejects.toThrow('PROJECT_FILE_SOURCE_ACCESS_REVOKED');
});
it('observes current membership revoke on the next read/write and leaves bytes intact', async () => {
  await read(); member = false;
  await expect(read()).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  await expect(write()).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  expect(fs.readFileSync(path.join(root, 'index.html'), 'utf8')).toBe(before);
});
it('rejects revoke between first resolution and write recheck', async () => {
  afterTeamSnapshot = count => { if (count === 3) member = false; };
  await expect(write()).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  expect(fs.readFileSync(path.join(root, 'index.html'), 'utf8')).toBe(before);
});
it('rejects a team identity change between first resolution and write recheck', async () => {
  afterTeamSnapshot = count => { if (count === 3) teamId = 'team-b'; };
  await expect(write()).rejects.toThrow('WORKSPACE_WRITE_CONTEXT_CHANGED');
  expect(fs.readFileSync(path.join(root, 'index.html'), 'utf8')).toBe(before);
});
it('rejects disappearance of the allowed workspace between write resolutions', async () => {
  afterTeamSnapshot = count => { if (count === 3) workspacePresent = false; };
  await expect(write()).rejects.toThrow('TEAM_WORKSPACE_NOT_GRANTED');
  expect(fs.readFileSync(path.join(root, 'index.html'), 'utf8')).toBe(before);
});
it('rejects storage changes between write resolutions before I/O', async () => {
  afterStorageSnapshot = count => { if (count === 1) { storageKind = 'worker'; workerId = 'storage-b'; } };
  await expect(write()).rejects.toThrow('WORKSPACE_WRITE_CONTEXT_CHANGED');
  expect(compareAndSwapWorkerProjectFile).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(root, 'index.html'), 'utf8')).toBe(before);
});
it('rejects a storage mismatch at read adapter resolution, without host fallback', async () => {
  vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue({ projectId: 'b', projectRoot: root, relativePath: ref.relativePath, workerId: 'unexpected-worker' } as any);
  await expect(read()).rejects.toThrow('WORKSPACE_STORAGE_CHANGED');
  expect(downloadWorkerProjectFile).not.toHaveBeenCalled();
});
it('rejects a Worker project/relative-path identity mismatch before transport', async () => {
  vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue({ projectId: 'other', projectRoot: root, relativePath: ref.relativePath, workerId: 'storage-b' } as any);
  await expect(read()).rejects.toThrow('PROJECT_WORKSPACE_STORAGE_CHANGED');
  expect(downloadWorkerProjectFile).not.toHaveBeenCalled();
});
it('reuses bounded Worker read/write adapters with team access rather than duplicate I/O', async () => {
  storageKind = 'worker'; workerId = 'storage-b';
  const authority = { projectId: 'b', projectRoot: root, relativePath: ref.relativePath, workerId };
  vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(authority as any);
  vi.mocked(downloadWorkerProjectFile).mockResolvedValue(Buffer.from(before));
  expect(await read({ maxBytes: 1024 })).toMatchObject({ storageKind: 'worker', bytes: Buffer.from(before) });
  expect(downloadWorkerProjectFile).toHaveBeenCalledWith({ authority, actorUserId: 1, maxBytes: 1024 });
  await write();
  expect(compareAndSwapWorkerProjectFile).toHaveBeenCalledWith({ authority, actorUserId: 1, expectedContent: before, content: 'changed' });
  // Worker transport is mocked: the host file is not used as a fallback.
  expect(fs.readFileSync(path.join(root, 'index.html'), 'utf8')).toBe(before);
});
it('rejects a Worker change at write adapter resolution before transport', async () => {
  storageKind = 'worker'; workerId = 'storage-b';
  vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue({ projectId: 'b', projectRoot: root, relativePath: ref.relativePath, workerId: 'storage-other' } as any);
  await expect(write()).rejects.toThrow('WORKSPACE_STORAGE_CHANGED');
  expect(compareAndSwapWorkerProjectFile).not.toHaveBeenCalled();
});
it('rejects a nested registered Project even though the parent is in team inventory', async () => {
  nested = true;
  await expect(read({ ref: { ...ref, relativePath: 'child/index.html' } })).rejects.toThrow('WORKSPACE_NESTED_PROJECT_NOT_GRANTED');
  await expect(write({ ref: { ...ref, relativePath: 'child/index.html' } })).rejects.toThrow('WORKSPACE_NESTED_PROJECT_NOT_GRANTED');
});
it('reads an internal alias but rejects writes through it', async () => {
  fs.symlinkSync(path.join(root, 'index.html'), path.join(root, 'link.html'));
  await expect(read({ ref: { ...ref, relativePath: 'link.html' } })).resolves.toMatchObject({ bytes: Buffer.from(before) });
  await expect(write({ ref: { ...ref, relativePath: 'link.html' } })).rejects.toThrow();
  expect(fs.readFileSync(path.join(root, 'index.html'), 'utf8')).toBe(before);
});
it('rejects a hard-linked write without touching the original bytes', async () => {
  fs.linkSync(path.join(root, 'index.html'), path.join(root, 'hard.html'));
  await expect(write({ ref: { ...ref, relativePath: 'hard.html' } })).rejects.toThrow();
  expect(fs.readFileSync(path.join(root, 'index.html'), 'utf8')).toBe(before);
});
it('retains bounded I/O and expected-content CAS', async () => {
  await expect(read({ maxBytes: 1 })).rejects.toThrow();
  await expect(write({ content: 'x'.repeat(1024 * 1024 + 1) })).rejects.toThrow('WORKSPACE_WRITE_LIMIT_INVALID');
  await expect(write({ expectedContent: 'stale' })).rejects.toThrow();
  expect(fs.readFileSync(path.join(root, 'index.html'), 'utf8')).toBe(before);
});
