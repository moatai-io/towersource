import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryOneMock = vi.hoisted(() => vi.fn());
const findProjectByPathMock = vi.hoisted(() => vi.fn());
const getDefaultProjectIdsMock = vi.hoisted(() => vi.fn());

vi.mock('../../db/pg-repo.js', () => ({
  queryOne: (...args: any[]) => queryOneMock(...args),
}));

vi.mock('../../config.js', () => ({
  config: { defaultCwd: '/workspace' },
}));

vi.mock('../pm/project-access.js', () => ({
  findProjectByPath: (...args: any[]) => findProjectByPathMock(...args),
}));

vi.mock('../pm/project-manager.js', () => ({
  getDefaultProjectIds: (...args: any[]) => getDefaultProjectIdsMock(...args),
}));

const { resolveSessionCreationContext } = await import('./session-creation-context.js');

describe('resolveSessionCreationContext', () => {
  beforeEach(() => {
    queryOneMock.mockReset();
    findProjectByPathMock.mockReset();
    getDefaultProjectIdsMock.mockReset();
    getDefaultProjectIdsMock.mockResolvedValue([]);
  });

  it('keeps explicit cwd and infers project when projectId is omitted', async () => {
    findProjectByPathMock.mockResolvedValueOnce('project-from-path');

    await expect(resolveSessionCreationContext({ cwd: '/workspace/projects/foo' })).resolves.toEqual({
      cwd: '/workspace/projects/foo',
      projectId: 'project-from-path',
    });
  });

  it('inherits parent project root for session panel threads without falling back to workspace root', async () => {
    queryOneMock.mockResolvedValueOnce({
      cwd: '/workspace',
      project_id: 'parent-project',
      project_root_path: '/workspace/projects/parent',
    });

    await expect(resolveSessionCreationContext({ parentSessionId: 'parent-session' })).resolves.toEqual({
      cwd: '/workspace/projects/parent',
      projectId: 'parent-project',
    });
  });

  it('uses room project root for room message threads when cwd is omitted', async () => {
    queryOneMock.mockResolvedValueOnce({
      project_id: 'room-project',
      project_root_path: '/workspace/projects/room',
    });

    await expect(resolveSessionCreationContext({ roomId: 'room-1' })).resolves.toEqual({
      cwd: '/workspace/projects/room',
      projectId: 'room-project',
    });
  });

  it('uses explicit project root when projectId is provided without cwd', async () => {
    queryOneMock.mockResolvedValueOnce({ root_path: '/workspace/projects/explicit' });

    await expect(resolveSessionCreationContext({ projectId: 'explicit-project' })).resolves.toEqual({
      cwd: '/workspace/projects/explicit',
      projectId: 'explicit-project',
    });
  });

  it('falls back to parent cwd only when the parent has no project root', async () => {
    queryOneMock.mockResolvedValueOnce({
      cwd: '/legacy/context',
      project_id: null,
      project_root_path: null,
    });

    await expect(resolveSessionCreationContext({ parentSessionId: 'legacy-parent' })).resolves.toEqual({
      cwd: '/legacy/context',
      projectId: null,
    });
  });

  it('uses the first signup-visible default project for a top-level session with no context', async () => {
    getDefaultProjectIdsMock.mockResolvedValueOnce(['general-project']);
    queryOneMock.mockResolvedValueOnce({ root_path: '/workspace/projects/general' });

    await expect(resolveSessionCreationContext({ role: 'member' })).resolves.toEqual({
      cwd: '/workspace/projects/general',
      projectId: 'general-project',
    });
  });

  it('keeps project-less temp fallback only when no default project exists', async () => {
    getDefaultProjectIdsMock.mockResolvedValueOnce([]);

    await expect(resolveSessionCreationContext({ role: 'member' })).resolves.toEqual({
      cwd: '/workspace',
      projectId: null,
    });
  });
});
