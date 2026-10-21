import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { query } from '../../db/pg-repo.js';
import { requireAgentWorkspaceAccess } from './access.js';
import { listCurrentTeamWorkspaces } from './team-inventory.js';
import { resolveTeamAgentContext } from './team-context.js';
import { resolveProjectWorkspaceTarget } from '../project-environment/project-workspace-authority.js';
import { resolveAgentFileReference as resolve } from './file-reference.js';
vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn() }));
vi.mock('./access.js', () => ({ requireAgentWorkspaceAccess: vi.fn() }));
vi.mock('./team-inventory.js', () => ({ listCurrentTeamWorkspaces: vi.fn() }));
vi.mock('./team-context.js', () => ({ resolveTeamAgentContext: vi.fn() }));
vi.mock('../project-environment/project-workspace-authority.js', () => ({ resolveProjectWorkspaceTarget: vi.fn() }));
vi.mock('../project-environment/project-environment-deployment.js', () => ({ resolveProjectEnvironmentDeploymentId: () => 'test' }));
const request = { userId: 1, trustedAgentProjectId: 'a', ref: { agentProjectId: 'a', workspaceId: 'b-files', relativePath: 'final/한글.html' }, operation: 'read' as const };
const context = { teamId: 'team-a', agentProjectId: 'a', userId: 1 };
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '1');
  vi.mocked(listCurrentTeamWorkspaces).mockResolvedValue([{ workspaceId: 'b-files', ownerProjectId: 'b' }]);
  vi.mocked(resolveTeamAgentContext).mockResolvedValue(context);
  vi.mocked(requireAgentWorkspaceAccess).mockRejectedValue(new Error('UNEXPECTED_LEGACY_ACCESS'));
  vi.mocked(query).mockResolvedValue([{ id: 'b', root_path: '/workspace/b' }]);
  vi.mocked(resolveProjectWorkspaceTarget).mockResolvedValue({ workstationMode: true, defaultWorkerId: 'storage-b' } as any);
});
afterEach(() => vi.unstubAllEnvs());
it('uses team inventory and canonical registered owner without a legacy grant or Project member', async () => {
  expect(await resolve(request)).toMatchObject({ ownerProjectId: 'b', projectRoot: '/workspace/b',
    access: { provenance: 'team', teamId: 'team-a' }, storage: { kind: 'worker', workerId: 'storage-b' } });
  expect(listCurrentTeamWorkspaces).toHaveBeenCalledWith({ userId: 1, agentProjectId: 'a' });
  expect(requireAgentWorkspaceAccess).not.toHaveBeenCalled();
  expect(query).toHaveBeenCalledTimes(1);
  expect(vi.mocked(query).mock.calls[0][0]).not.toMatch(/project_members|grants|INSERT|UPDATE/i);
});
it.each([undefined, '0', 'true'])('is off unless the exact feature switch is 1 (%s)', async enabled => {
  vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', enabled);
  vi.mocked(requireAgentWorkspaceAccess).mockResolvedValue({ ownerProjectId: 'b', ownerRootPath: '/workspace/b', workspaceKind: 'project', mode: 'read', grantVersion: 1 } as any);
  expect(await resolve(request)).toMatchObject({ access: { provenance: 'legacy', grantVersion: 1 } });
  expect(listCurrentTeamWorkspaces).not.toHaveBeenCalled();
  expect(resolveTeamAgentContext).not.toHaveBeenCalled();
});
it('falls back only for an explicitly teamless null inventory', async () => {
  vi.mocked(resolveTeamAgentContext).mockResolvedValue(null);
  vi.mocked(listCurrentTeamWorkspaces).mockResolvedValue(null);
  vi.mocked(requireAgentWorkspaceAccess).mockResolvedValue({ ownerProjectId: 'b', ownerRootPath: '/workspace/b', workspaceKind: 'project', mode: 'read', grantVersion: 2 } as any);
  expect(await resolve(request)).toMatchObject({ access: { provenance: 'legacy', grantVersion: 2 } });
  expect(requireAgentWorkspaceAccess).toHaveBeenCalledTimes(1);
});
it.each([{ inventory: [] }, { inventory: [{ workspaceId: 'other', ownerProjectId: 'b' }] }])('denies an absent workspace rather than using legacy access ($inventory)', async ({ inventory }) => {
  vi.mocked(listCurrentTeamWorkspaces).mockResolvedValue(inventory);
  await expect(resolve(request)).rejects.toThrow('TEAM_WORKSPACE_NOT_GRANTED');
  expect(requireAgentWorkspaceAccess).not.toHaveBeenCalled();
  expect(resolveProjectWorkspaceTarget).not.toHaveBeenCalled();
});
it('propagates unavailable/denied inventory without fallback', async () => {
  vi.mocked(listCurrentTeamWorkspaces).mockRejectedValue(new Error('TEAM_WORKSPACE_ACCESS_DENIED'));
  await expect(resolve(request)).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  expect(requireAgentWorkspaceAccess).not.toHaveBeenCalled();
});
it('propagates denied team context without fallback', async () => {
  vi.mocked(resolveTeamAgentContext).mockRejectedValue(new Error('TEAM_WORKSPACE_ACCESS_DENIED'));
  await expect(resolve(request)).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  expect(requireAgentWorkspaceAccess).not.toHaveBeenCalled();
});
it.each([null, { ...context, teamId: 'team-b' }])('rejects changing team identity around inventory (%j)', async current => {
  vi.mocked(resolveTeamAgentContext).mockResolvedValueOnce(context).mockResolvedValueOnce(current);
  await expect(resolve(request)).rejects.toThrow('TEAM_WORKSPACE_CONTEXT_CHANGED');
  expect(requireAgentWorkspaceAccess).not.toHaveBeenCalled();
});
it('does not accept null inventory when team identity is present', async () => {
  vi.mocked(listCurrentTeamWorkspaces).mockResolvedValue(null);
  await expect(resolve(request)).rejects.toThrow('TEAM_WORKSPACE_CONTEXT_CHANGED');
  expect(requireAgentWorkspaceAccess).not.toHaveBeenCalled();
});
it.each([{ projects: [] }, { projects: [{ id: 'b', root_path: '' }] }, { projects: [{ id: 'b', root_path: 'relative/b' }] }])('requires the registered owner root ($projects)', async ({ projects }) => {
  vi.mocked(query).mockResolvedValue(projects);
  await expect(resolve(request)).rejects.toThrow('WORKSPACE_STORAGE_LOCATOR_UNAVAILABLE');
});
it('rejects a filesystem root locator', async () => {
  vi.mocked(query).mockResolvedValue([{ id: 'b', root_path: '/' }]);
  await expect(resolve(request)).rejects.toThrow('WORKSPACE_STORAGE_LOCATOR_INVALID');
});
it('does not grant a nested registered Project', async () => {
  vi.mocked(query).mockResolvedValue([{ id: 'nested', root_path: '/workspace/b/final' }, { id: 'b', root_path: '/workspace/b' }]);
  await expect(resolve(request)).rejects.toThrow('WORKSPACE_NESTED_PROJECT_NOT_GRANTED');
});
it('preserves trusted Agent context, operation and path validation before querying team data', async () => {
  await expect(resolve({ ...request, trustedAgentProjectId: 'other' })).rejects.toThrow('AGENT_FILE_CONTEXT_MISMATCH');
  await expect(resolve({ ...request, operation: 'delete' as any })).rejects.toThrow('WORKSPACE_OPERATION_INVALID');
  await expect(resolve({ ...request, ref: { ...request.ref, relativePath: '../outside' } })).rejects.toThrow('WORKSPACE_RELATIVE_PATH_INVALID');
  await expect(resolve({ ...request, operation: 'write', ref: { ...request.ref, relativePath: '.' } })).rejects.toThrow('WORKSPACE_ROOT_MUTATION_DENIED');
  expect(listCurrentTeamWorkspaces).not.toHaveBeenCalled();
});
it('propagates storage readiness/configuration failures', async () => {
  vi.mocked(resolveProjectWorkspaceTarget).mockRejectedValueOnce(new Error('WORKSPACE_STORAGE_NOT_READY'));
  await expect(resolve(request)).rejects.toThrow('WORKSPACE_STORAGE_NOT_READY');
  vi.mocked(resolveProjectWorkspaceTarget).mockResolvedValue({ workstationMode: true, defaultWorkerId: null } as any);
  await expect(resolve(request)).rejects.toThrow('WORKSPACE_STORAGE_CONFIGURATION_CONFLICT');
});
