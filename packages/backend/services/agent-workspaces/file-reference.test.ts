import { beforeEach, expect, it, vi } from 'vitest';
import { query } from '../../db/pg-repo.js';
import { requireAgentWorkspaceAccess } from './access.js';
import { resolveProjectWorkspaceTarget } from '../project-environment/project-workspace-authority.js';
import { resolveAgentFileReference as resolve, validateAgentFileRef } from './file-reference.js';
vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn() }));
vi.mock('./access.js', () => ({ requireAgentWorkspaceAccess: vi.fn() }));
vi.mock('../project-environment/project-workspace-authority.js', () => ({ resolveProjectWorkspaceTarget: vi.fn() }));
vi.mock('../project-environment/project-environment-deployment.js', () => ({ resolveProjectEnvironmentDeploymentId: () => 'test' }));
const request = { userId: 1, trustedAgentProjectId: 'a', ref: { agentProjectId: 'a', workspaceId: 'b-files', relativePath: 'final/한글.html' }, operation: 'read' as const };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireAgentWorkspaceAccess).mockResolvedValue({ ownerProjectId: 'b', ownerRootPath: '/workspace/b', workspaceKind: 'project', mode: 'read', grantVersion: 1 } as any);
  vi.mocked(query).mockResolvedValue([{ id: 'b', root_path: '/workspace/b' }]);
  vi.mocked(resolveProjectWorkspaceTarget).mockResolvedValue({ workstationMode: true, defaultWorkerId: 'storage-b' } as any);
});
it('uses the connected workspace owner storage, not the receiving Agent execution location', async () => {
  expect(await resolve(request)).toMatchObject({ ownerProjectId: 'b', hostPath: '/workspace/b/final/한글.html', storage: { kind: 'worker', workerId: 'storage-b' } });
  expect(resolveProjectWorkspaceTarget).toHaveBeenCalledWith('b', 'test');
});
it('rejects a client-selected Agent context before querying authority', async () => {
  await expect(resolve({ ...request, trustedAgentProjectId: 'other' })).rejects.toThrow('CONTEXT_MISMATCH');
  expect(requireAgentWorkspaceAccess).not.toHaveBeenCalled();
});
it('denies storage discovery after access denial', async () => {
  vi.mocked(requireAgentWorkspaceAccess).mockRejectedValue(new Error('WORKSPACE_NOT_GRANTED'));
  await expect(resolve(request)).rejects.toThrow('NOT_GRANTED');
  expect(query).not.toHaveBeenCalled(); expect(resolveProjectWorkspaceTarget).not.toHaveBeenCalled();
});
it.each(['/etc/passwd', '../other', 'a/../b', 'a//b', 'a\\b', '%2e%2e/x', 'file://root'])('rejects path syntax %s', relativePath => {
  expect(() => validateAgentFileRef({ ...request.ref, relativePath })).toThrow();
});
it('protects nested Project boundaries', async () => {
  vi.mocked(query).mockResolvedValue([{ id: 'child', root_path: '/workspace/b/final' }, { id: 'b', root_path: '/workspace/b' }]);
  await expect(resolve(request)).rejects.toThrow('NESTED_PROJECT_NOT_GRANTED');
});
it('does not guess shared-skill storage or mutate the root', async () => {
  vi.mocked(requireAgentWorkspaceAccess).mockResolvedValue({ workspaceKind: 'shared-skills', ownerProjectId: null } as any);
  await expect(resolve(request)).rejects.toThrow('LOCATOR_UNAVAILABLE');
  await expect(resolve({ ...request, operation: 'write', ref: { ...request.ref, relativePath: '.' } })).rejects.toThrow('ROOT_MUTATION_DENIED');
});
it('propagates unready storage without fallback', async () => {
  vi.mocked(resolveProjectWorkspaceTarget).mockRejectedValue(new Error('WORKSPACE_STORAGE_NOT_READY'));
  await expect(resolve(request)).rejects.toThrow('STORAGE_NOT_READY');
});
