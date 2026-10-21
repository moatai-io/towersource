import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { resolveAgentFileReference } from './file-reference.js';
import { resolveWorkerFileAuthorityForHostPath, downloadWorkerProjectFile } from '../runtime-box/workbench-project-file-authority.js';
import { readCanonicalProjectFileBytes } from '../project-environment/adapters/canonical-host-file-adapter.js';
import { readAgentWorkspaceFile as read } from './read-file.js';
vi.mock('./file-reference.js', () => ({ resolveAgentFileReference: vi.fn() }));
vi.mock('../runtime-box/workbench-project-file-authority.js', () => ({ resolveWorkerFileAuthorityForHostPath: vi.fn(), downloadWorkerProjectFile: vi.fn() }));
let root: string;
const request = { userId: 1, trustedAgentProjectId: 'a', ref: { agentProjectId: 'a', workspaceId: 'b-files', relativePath: '한글.html' } };
beforeEach(() => {
  vi.resetAllMocks(); root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-read-test-'));
  fs.writeFileSync(path.join(root, '한글.html'), '<h1>안녕하세요</h1>');
  vi.mocked(resolveAgentFileReference).mockResolvedValue({ projectRoot: root, hostPath: path.join(root, '한글.html'), ownerProjectId: 'b', storage: { kind: 'host', workerId: null } } as any);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it('reads a real HTML file via authorized reference', async () => {
  const result = await read(request);
  expect(result.bytes.toString()).toBe('<h1>안녕하세요</h1>');
  expect(result.ref).toEqual(request.ref);
  expect(resolveAgentFileReference).toHaveBeenCalledWith(expect.objectContaining({ operation: 'read' }));
});
it('does not read storage when access is denied', async () => {
  vi.mocked(resolveAgentFileReference).mockRejectedValue(new Error('WORKSPACE_NOT_GRANTED'));
  await expect(read(request)).rejects.toThrow('NOT_GRANTED');
  expect(downloadWorkerProjectFile).not.toHaveBeenCalled();
});
it('reads safe internal aliases but rejects hardlinks', () => {
  fs.symlinkSync(path.join(root, '한글.html'), path.join(root, 'link'));
  expect(readCanonicalProjectFileBytes(root, 'link', 100)).toEqual(fs.readFileSync(path.join(root, '한글.html')));
  fs.symlinkSync(root, path.join(root, 'alias'));
  expect(readCanonicalProjectFileBytes(root, 'alias/한글.html', 100)).toEqual(fs.readFileSync(path.join(root, '한글.html')));
  fs.linkSync(path.join(root, '한글.html'), path.join(root, 'hard'));
  expect(() => readCanonicalProjectFileBytes(root, 'hard', 100)).toThrow('SPECIAL_FILE');
});
it('bounds file size and rejects traversal', async () => {
  await expect(read({ ...request, maxBytes: 1 })).rejects.toThrow('SIZE_LIMIT');
  expect(() => readCanonicalProjectFileBytes(root, '../escape', 100)).toThrow('PATH_INVALID');
});
it('reads matching Worker bytes and never falls back after storage changes', async () => {
  vi.mocked(resolveAgentFileReference).mockResolvedValue({ projectRoot: root, hostPath: path.join(root, '한글.html'), ownerProjectId: 'b', storage: { kind: 'worker', workerId: 'w' } } as any);
  vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue({ projectId: 'b', workerId: 'w', relativePath: '한글.html', projectRoot: root, workerBaseUrl: 'http://worker.example.com' });
  vi.mocked(downloadWorkerProjectFile).mockResolvedValue(Buffer.from('worker bytes'));
  expect((await read(request)).bytes.toString()).toBe('worker bytes');
  vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(undefined);
  await expect(read(request)).rejects.toThrow('STORAGE_CHANGED');
  expect(downloadWorkerProjectFile).toHaveBeenCalledTimes(1);
});
