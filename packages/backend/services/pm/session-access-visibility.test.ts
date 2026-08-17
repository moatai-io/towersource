import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/pg-repo.js', () => ({
  queryOne: vi.fn(),
}));

vi.mock('./project-membership-manager.js', () => ({
  getAccessibleProjectIds: vi.fn(),
  isProjectMember: vi.fn(),
}));

vi.mock('../session/session-share-manager.js', () => ({
  hasInternalShareAccess: vi.fn(),
}));

const { queryOne } = await import('../../db/pg-repo.js');
const { isProjectMember } = await import('./project-membership-manager.js');
const { hasInternalShareAccess } = await import('../session/session-share-manager.js');
const { canAccessSession } = await import('./project-access.js');

const queryOneMock = vi.mocked(queryOne);
const isProjectMemberMock = vi.mocked(isProjectMember);
const hasInternalShareAccessMock = vi.mocked(hasInternalShareAccess);

describe('canAccessSession privacy visibility', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    hasInternalShareAccessMock.mockResolvedValue(false);
    isProjectMemberMock.mockResolvedValue(true);
  });

  it('denies project members from opening another user private session', async () => {
    queryOneMock.mockResolvedValue({
      user_id: 20,
      project_id: 'project-allowed',
      visibility: 'private',
      label: 'temp',
    });

    const access = await canAccessSession('session-private', 10, 'member');

    expect(access.allowed).toBe(false);
    if (!access.allowed) expect(access.message).toContain('private session');
    expect(isProjectMemberMock).not.toHaveBeenCalled();
  });

  it('allows project members to open another user project-shared session', async () => {
    queryOneMock.mockResolvedValue({
      user_id: 20,
      project_id: 'project-allowed',
      visibility: 'project',
      label: 'temp',
    });
    isProjectMemberMock.mockResolvedValue(true);

    await expect(canAccessSession('session-shared', 10, 'member')).resolves.toEqual({ allowed: true });
  });

  it('allows explicit internal share access even when the session is private', async () => {
    queryOneMock.mockResolvedValue({
      user_id: 20,
      project_id: 'project-allowed',
      visibility: 'private',
      label: 'temp',
    });
    hasInternalShareAccessMock.mockResolvedValue(true);

    await expect(canAccessSession('session-shared-directly', 10, 'member')).resolves.toEqual({ allowed: true });
  });
});
