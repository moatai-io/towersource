import { beforeEach, describe, expect, it, vi } from 'vitest';

// Reuse the mock boundaries of session-access-visibility.test.ts, not a fake team
// schema. These are characterization tests of CURRENT Session ACL behavior.
// Passing does NOT prove the planned team/file-vs-conversation separation works:
// team access must never be OR-ed into isProjectMember or seeded into
// project_members, and a future team-only owner needs a separate access rule.
vi.mock('../../db/pg-repo.js', () => ({ queryOne: vi.fn() }));
vi.mock('./project-membership-manager.js', () => ({
  getAccessibleProjectIds: vi.fn(),
  isProjectMember: vi.fn(),
}));
vi.mock('../session/session-share-manager.js', () => ({ hasInternalShareAccess: vi.fn() }));

const { queryOne } = await import('../../db/pg-repo.js');
const { isProjectMember } = await import('./project-membership-manager.js');
const { hasInternalShareAccess } = await import('../session/session-share-manager.js');
const { canAccessSession, canSendSessionMessage, canWriteSessionContent } = await import('./project-access.js');

const queryOneMock = vi.mocked(queryOne);
const isProjectMemberMock = vi.mocked(isProjectMember);
const hasInternalShareAccessMock = vi.mocked(hasInternalShareAccess);
const actorId = 10;
const projectId = 'project-a';
const sessionId = 'session-a';

function loadCurrentAclFixture(input: {
  ownerId: number;
  visibility: 'private' | 'project';
  projectMember: boolean;
}): void {
  const session = {
    user_id: input.ownerId,
    project_id: projectId,
    visibility: input.visibility,
    room_id: null,
    label: null,
  };
  isProjectMemberMock.mockResolvedValue(input.projectMember);
  queryOneMock.mockImplementation(async (sql, params) => {
    if (sql.includes('FROM sessions WHERE id = $1')) {
      expect(params).toEqual([sessionId]);
      return session;
    }
    if (sql.includes('FROM project_members pm')) {
      expect(params).toEqual([projectId, actorId]);
      return input.projectMember ? { role: 'member' } : undefined;
    }
    if (sql.includes('SELECT 1 AS ok WHERE')) return { ok: 1 };
    throw new Error(`Unexpected ACL fixture query: ${sql}`);
  });
}

const contributionGuards = [
  ['send', canSendSessionMessage],
  ['content write', canWriteSessionContent],
] as const;

describe('current Session ACL characterization — NOT team policy acceptance', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    hasInternalShareAccessMock.mockResolvedValue(false);
  });

  it.each(['private', 'project'] as const)(
    'currently denies even the owner %s reads without Project membership',
    async visibility => {
      // This existing prerequisite blocks a future team-only owner; recording
      // the behavior does not endorse it as the desired team policy.
      loadCurrentAclFixture({ ownerId: actorId, visibility, projectMember: false });
      await expect(canAccessSession(sessionId, actorId, 'member')).resolves.toEqual({
        allowed: false,
        status: 403,
        message: 'Access denied: Project membership required',
      });
      expect(isProjectMemberMock).toHaveBeenCalledWith(projectId, actorId);
    },
  );

  it('allows another owner project Session read when Project membership is present', async () => {
    // OR-ing team access into this helper would also grant this read.
    loadCurrentAclFixture({ ownerId: 20, visibility: 'project', projectMember: true });
    await expect(canAccessSession(sessionId, actorId, 'member')).resolves.toEqual({ allowed: true });
    expect(isProjectMemberMock).toHaveBeenCalledWith(projectId, actorId);
  });

  it('denies another owner project Session read without Project membership', async () => {
    loadCurrentAclFixture({ ownerId: 20, visibility: 'project', projectMember: false });
    await expect(canAccessSession(sessionId, actorId, 'member')).resolves.toMatchObject({
      allowed: false, status: 403, message: 'Access denied: Project membership required',
    });
  });

  describe.each(contributionGuards)('%s through the real canContributeSession caller', (_action, authorize) => {
    it('currently allows the owner contribution without the membership required by reads', async () => {
      // Characterize the read/write mismatch; this is not a revocation guarantee.
      loadCurrentAclFixture({ ownerId: actorId, visibility: 'private', projectMember: false });
      await expect(authorize(sessionId, actorId, 'member')).resolves.toEqual({
        allowed: true, reason: 'owner_match',
      });
      expect(isProjectMemberMock).not.toHaveBeenCalled();
      expect(queryOneMock).toHaveBeenCalledTimes(1);
    });

    it('allows another owner project Session contribution for a writable Project member', async () => {
      // Auto-seeding a team invite into project_members would grant this too.
      loadCurrentAclFixture({ ownerId: 20, visibility: 'project', projectMember: true });
      await expect(authorize(sessionId, actorId, 'member')).resolves.toEqual({
        allowed: true, reason: 'project_participant',
      });
      expect(queryOneMock).toHaveBeenCalledWith(
        expect.stringContaining('FROM project_members pm'), [projectId, actorId],
      );
    });

    it('denies another owner project Session contribution without Project membership', async () => {
      loadCurrentAclFixture({ ownerId: 20, visibility: 'project', projectMember: false });
      await expect(authorize(sessionId, actorId, 'member')).resolves.toMatchObject({
        allowed: false, status: 403, reason: 'owner_mismatch',
      });
      expect(queryOneMock).toHaveBeenCalledWith(
        expect.stringContaining('FROM project_members pm'), [projectId, actorId],
      );
    });

    it('denies another owner private Session contribution even with Project membership', async () => {
      loadCurrentAclFixture({ ownerId: 20, visibility: 'private', projectMember: true });
      await expect(authorize(sessionId, actorId, 'member')).resolves.toMatchObject({
        allowed: false, status: 403, reason: 'owner_mismatch',
      });
      expect(queryOneMock).not.toHaveBeenCalledWith(
        expect.stringContaining('FROM project_members pm'), expect.anything(),
      );
    });
  });

  it('denies another owner private Session read even with Project membership and an internal share', async () => {
    loadCurrentAclFixture({ ownerId: 20, visibility: 'private', projectMember: true });
    hasInternalShareAccessMock.mockResolvedValue(true);
    await expect(canAccessSession(sessionId, actorId, 'member')).resolves.toMatchObject({
      allowed: false, status: 403, message: 'Access denied: private session',
    });
    expect(isProjectMemberMock).not.toHaveBeenCalled();
    expect(hasInternalShareAccessMock).not.toHaveBeenCalled();
  });
});
