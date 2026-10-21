import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { resolveAgentFileReference } from './file-reference.js';
import { replaceAgentWorkspaceText as replace } from './write-file.js';
vi.mock('./file-reference.js', () => ({ resolveAgentFileReference: vi.fn() }));
vi.mock('../runtime-box/workbench-project-file-authority.js', () => ({ compareAndSwapWorkerProjectFile: vi.fn(), resolveWorkerFileAuthorityForHostPath: vi.fn() }));
let root: string;
const request = { userId: 1, trustedAgentProjectId: 'a', ref: { agentProjectId: 'a', workspaceId: 'b', relativePath: '문서.html' }, expectedContent: 'before', content: 'after' };
beforeEach(() => {
  vi.resetAllMocks(); root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-write-'));
  fs.writeFileSync(path.join(root, request.ref.relativePath), 'before', { mode: 0o640 });
  vi.mocked(resolveAgentFileReference).mockResolvedValue({ projectRoot: root, ownerProjectId: 'b', deploymentId: 'test', access: { grantVersion: 1 }, storage: { kind: 'host', workerId: null } } as any);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it('replaces bytes, preserves permissions and leaves no stage file', async () => {
  expect(await replace(request)).toMatchObject({ bytesWritten: 5 });
  expect(fs.readFileSync(path.join(root, request.ref.relativePath), 'utf8')).toBe('after');
  expect(fs.statSync(path.join(root, request.ref.relativePath)).mode & 0o777).toBe(0o640);
  expect(fs.readdirSync(root)).toEqual(['문서.html']);
});
it('preserves an independently edited file', async () => {
  fs.writeFileSync(path.join(root, request.ref.relativePath), 'someone else');
  await expect(replace(request)).rejects.toThrow('STALE');
  expect(fs.readFileSync(path.join(root, request.ref.relativePath), 'utf8')).toBe('someone else');
});
it('rechecks revocation before writing', async () => {
  const resolved = await resolveAgentFileReference({} as any);
  vi.mocked(resolveAgentFileReference).mockReset().mockResolvedValueOnce(resolved).mockRejectedValueOnce(new Error('WORKSPACE_NOT_GRANTED'));
  await expect(replace(request)).rejects.toThrow('NOT_GRANTED');
  expect(fs.readFileSync(path.join(root, request.ref.relativePath), 'utf8')).toBe('before');
});
it('rejects symlink targets without overwriting their destination', async () => {
  fs.renameSync(path.join(root, request.ref.relativePath), path.join(root, 'original'));
  fs.symlinkSync(path.join(root, 'original'), path.join(root, request.ref.relativePath));
  await expect(replace(request)).rejects.toThrow();
  expect(fs.readFileSync(path.join(root, 'original'), 'utf8')).toBe('before');
});
it('does not create missing files or accept oversized writes', async () => {
  await expect(replace({ ...request, ref: { ...request.ref, relativePath: 'missing' } })).rejects.toThrow();
  await expect(replace({ ...request, content: 'x'.repeat(1024 * 1024 + 1) })).rejects.toThrow('LIMIT_INVALID');
});
