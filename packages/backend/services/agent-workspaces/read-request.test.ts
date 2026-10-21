import { beforeEach, expect, it, vi } from 'vitest';
import { readAgentWorkspaceFile } from './read-file.js';
import { readAgentWorkspaceRequest } from './read-request.js';
vi.mock('./read-file.js', () => ({ readAgentWorkspaceFile: vi.fn() }));
const context = { userId: 1, agentProjectId: 'a' };
const ref = { agentProjectId: 'a', workspaceId: 'b-files', relativePath: 'final/index.html' };
beforeEach(() => vi.resetAllMocks());
it('passes authenticated context and a structured ref to common I/O', async () => {
  vi.mocked(readAgentWorkspaceFile).mockResolvedValue({ ref, storageKind: 'host', bytes: Buffer.from('ok') });
  expect((await readAgentWorkspaceRequest(context, { ref, maxBytes: 100 })).bytes.toString()).toBe('ok');
  expect(readAgentWorkspaceFile).toHaveBeenCalledWith({ userId: 1, trustedAgentProjectId: 'a', ref, maxBytes: 100 });
});
it.each([null, [], { ref, userId: 2 }, { ref, hostPath: '/etc/passwd' }, { ref, maxBytes: '100' }, { ref, maxBytes: 0 }, { ref, maxBytes: 9 * 1024 * 1024 }, { ref: { ...ref, agentProjectId: 'other' } }, { ref: { ...ref, relativePath: '../outside' } }, { ref: { ...ref, storage: 'host' } }])('rejects invalid or authority-bearing payloads before I/O: %j', async body => {
  await expect(readAgentWorkspaceRequest(context, body)).rejects.toThrow();
  expect(readAgentWorkspaceFile).not.toHaveBeenCalled();
});
it('requires a server-authenticated context', async () => {
  await expect(readAgentWorkspaceRequest({ ...context, userId: 0 }, { ref })).rejects.toThrow('CONTEXT_REQUIRED');
  expect(readAgentWorkspaceFile).not.toHaveBeenCalled();
});
