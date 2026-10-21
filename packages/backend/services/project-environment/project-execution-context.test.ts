import { describe, expect, it, vi } from 'vitest';
import { resolveProjectExecutionContext } from './project-execution-context.js';

const root = '/srv/workspace/projects/project-a';
function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    requireAccess: vi.fn().mockResolvedValue({ userRole: 'member', projectMember: true, projectOwner: false, projectWritable: true }),
    readProject: vi.fn().mockResolvedValue({ rootPath: root, lifecycleStatus: 'active', archived: false }),
    readLegacyPlacement: vi.fn().mockResolvedValue(undefined),
    readWorkspaceAuthorities: vi.fn().mockResolvedValue([{ project_id: 'project-a', deployment_id: 'production', storage_kind: 'host', worker_id: null, state: 'ready', version: 1 }]),
    realpath: vi.fn(async value => value),
    ...overrides,
  } as any;
}
const input = { projectId: 'project-a', actorUserId: 7, sessionId: 'session-a', deploymentId: 'production', requiredCapabilities: ['job'], expectedProjectRoot: root };

describe('Project Environment execution admission', () => {
  it('resolves a canonical workspace without a Project-to-Worker binding', async () => {
    await expect(resolveProjectExecutionContext(input, dependencies())).resolves.toEqual({
      projectId: 'project-a', deploymentId: 'production', actorUserId: 7, sessionId: 'session-a',
      userRole: 'member', projectWritable: true, projectRoot: root, logicalRoot: '/workspace',
      environmentMode: 'canonical-project-workspace', requiredCapabilities: ['job'],
    });
  });

  it('keeps an explicitly Worker-authoritative Project in legacy mode', async () => {
    const deps = dependencies({
      readLegacyPlacement: vi.fn().mockResolvedValue({ projectId: 'project-a', deploymentId: 'production', defaultWorkerId: 'worker-a', workstationMode: true, authorityMode: 'project' }),
      readWorkspaceAuthorities: vi.fn().mockResolvedValue([{ project_id: 'project-a', deployment_id: 'production', storage_kind: 'worker', worker_id: 'worker-a', state: 'ready', version: 1 }]),
    });
    await expect(resolveProjectExecutionContext(input, deps)).resolves.toMatchObject({
      environmentMode: 'legacy-worker-workspace', preferredExecutorId: 'worker-a',
    });
  });

  it('treats a historical workstation binding without a storage row as legacy', async () => {
    const deps = dependencies({
      readLegacyPlacement: vi.fn().mockResolvedValue({ projectId: 'project-a', deploymentId: 'production', defaultWorkerId: 'worker-a', workstationMode: true, authorityMode: 'project' }),
      readWorkspaceAuthorities: vi.fn().mockResolvedValue([]),
    });
    await expect(resolveProjectExecutionContext(input, deps)).resolves.toMatchObject({
      environmentMode: 'legacy-worker-workspace', preferredExecutorId: 'worker-a',
    });
  });

  it.each([
    ['inactive Project', { readProject: vi.fn().mockResolvedValue({ rootPath: root, lifecycleStatus: 'retired', archived: true }) }, 'PROJECT_EXECUTION_INACTIVE'],
    ['blocked storage', { readWorkspaceAuthorities: vi.fn().mockResolvedValue([{ project_id: 'project-a', deployment_id: 'production', storage_kind: 'host', worker_id: null, state: 'blocked', version: 1 }]) }, 'WORKSPACE_STORAGE_NOT_READY'],
    ['legacy storage without Worker', { readWorkspaceAuthorities: vi.fn().mockResolvedValue([{ project_id: 'project-a', deployment_id: 'production', storage_kind: 'worker', worker_id: null, state: 'ready', version: 1 }]) }, 'LEGACY_WORKER_BINDING_REQUIRED'],
    ['legacy storage mismatch', {
      readLegacyPlacement: vi.fn().mockResolvedValue({ defaultWorkerId: 'worker-a', workstationMode: true }),
      readWorkspaceAuthorities: vi.fn().mockResolvedValue([{ project_id: 'project-a', deployment_id: 'production', storage_kind: 'worker', worker_id: 'worker-b', state: 'ready', version: 1 }]),
    }, 'WORKSPACE_STORAGE_WORKER_MISMATCH'],
  ])('fails closed for %s', async (_label, override, message) => {
    await expect(resolveProjectExecutionContext(input, dependencies(override))).rejects.toThrow(message);
  });

  it('fails when the caller root differs from the canonical DB root', async () => {
    const deps = dependencies({ realpath: vi.fn(async value => value === '/wrong/project' ? '/wrong/project' : root) });
    await expect(resolveProjectExecutionContext({ ...input, expectedProjectRoot: '/wrong/project' }, deps)).rejects.toThrow('PROJECT_ROOT_MISMATCH');
  });

  it('propagates ACL denial before reading workspace state', async () => {
    const deps = dependencies({ requireAccess: vi.fn().mockRejectedValue(new Error('AGENT_EXECUTION_ACCESS_DENIED')) });
    await expect(resolveProjectExecutionContext(input, deps)).rejects.toThrow('AGENT_EXECUTION_ACCESS_DENIED');
    expect(deps.readWorkspaceAuthorities).not.toHaveBeenCalled();
    expect(deps.readLegacyPlacement).not.toHaveBeenCalled();
  });
});

it('rejects retired organization scope before authority or storage discovery', async () => {
  const deps = dependencies();
  await expect(resolveProjectExecutionContext({ ...input, executionScope: 'organization' }, deps)).rejects.toThrow('EXECUTION_SCOPE_UNSUPPORTED');
  expect(deps.requireAccess).not.toHaveBeenCalled();
  expect(deps.readWorkspaceAuthorities).not.toHaveBeenCalled();
  expect(deps.readProject).not.toHaveBeenCalled();
});
it('retains Project authority errors before storage discovery', async () => {
  const deps = dependencies({ requireAccess: vi.fn().mockRejectedValue(new Error('AGENT_EXECUTION_ACCESS_DENIED')) });
  await expect(resolveProjectExecutionContext(input, deps)).rejects.toThrow('AGENT_EXECUTION_ACCESS_DENIED');
  expect(deps.readWorkspaceAuthorities).not.toHaveBeenCalled();
});
it('rejects an unknown execution scope before querying authority', async () => {
  const deps = dependencies();
  await expect(resolveProjectExecutionContext({ ...input, executionScope: 'organizaton' as any }, deps)).rejects.toThrow('EXECUTION_SCOPE_INVALID');
  expect(deps.requireAccess).not.toHaveBeenCalled();
});
