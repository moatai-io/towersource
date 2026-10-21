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
const { canAccessSession, canAccessRoom, canCreateInProject, canDeleteSession, canInspectSessionMetadata, canAdministerSession, canMutateSessionMetadata, canSendSessionMessage, canWriteSessionContent } = await import('./project-access.js');

const queryOneMock = vi.mocked(queryOne);
const isProjectMemberMock = vi.mocked(isProjectMember);
const hasInternalShareAccessMock = vi.mocked(hasInternalShareAccess);

describe('canSendSessionMessage authority', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('allows the same user to send to an old session regardless of project', async () => {
    queryOneMock.mockResolvedValue({ user_id: 10 });

    await expect(canSendSessionMessage('old-session', 10, 'member')).resolves.toEqual({
      allowed: true,
      reason: 'owner_match',
    });
  });

  it('denies admin and operator cross-owner private send', async () => {
    queryOneMock.mockResolvedValue({ user_id: 20 });

    await expect(canSendSessionMessage('admin-target', 10, 'admin')).resolves.toMatchObject({ allowed: false, reason: 'owner_mismatch' });
    await expect(canSendSessionMessage('operator-target', 10, 'operator')).resolves.toMatchObject({
      allowed: false, status: 403, reason: 'owner_mismatch',
    });
  });

  it('keeps readable project members from gaining send authority', async () => {
    queryOneMock.mockResolvedValue({ user_id: 20 });

    await expect(canSendSessionMessage('shared-session', 10, 'member')).resolves.toEqual({
      allowed: false,
      status: 403,
      message: 'Access denied: Session message send requires Session ownership',
      reason: 'owner_mismatch',
    });
  });

  it('distinguishes a missing target session', async () => {
    queryOneMock.mockResolvedValue(undefined);

    await expect(canSendSessionMessage('missing-session', 10, 'member')).resolves.toEqual({
      allowed: false,
      status: 404,
      message: 'Session not found',
      reason: 'session_not_found',
    });
  });
});

describe('private secretary send boundary', () => {
  it('rejects an ordinary send even by the owner', async () => {
    vi.resetAllMocks();
    queryOneMock.mockResolvedValue({ user_id: 10, project_id: 'agent', visibility: 'private', label: 'personal_secretary', room_id: null });
    await expect(canSendSessionMessage('secretary', 10, 'member')).resolves.toMatchObject({ allowed: false, status: 403, reason: 'readonly_role' });
  });
});

describe('Session owner mutation authority', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each([
    ['metadata', canMutateSessionMetadata],
    ['content', canWriteSessionContent],
    ['administrative', canAdministerSession],
  ] as const)('keeps %s mutation narrower than read access', async (_kind, authorize) => {
    queryOneMock.mockResolvedValue({ user_id: 20 });
    await expect(authorize('shared-session', 10, 'member')).resolves.toMatchObject({
      allowed: false,
      status: 403,
      reason: 'owner_mismatch',
    });
  });

  it.each([
    ['metadata', canMutateSessionMetadata],
    ['content', canWriteSessionContent],
    ['administrative', canAdministerSession],
  ] as const)('allows owner but denies operator %s mutation of another private session', async (_kind, authorize) => {
    queryOneMock.mockResolvedValue({ user_id: 10 });
    await expect(authorize('owned-session', 10, 'member')).resolves.toEqual({ allowed: true, reason: 'owner_match' });
    queryOneMock.mockResolvedValue({ user_id: 20 });
    await expect(authorize('operated-session', 10, 'operator')).resolves.toMatchObject({ allowed: false, status: 403, reason: 'owner_mismatch' });
  });
});

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

  it('does not let an old internal share override private ownership', async () => {
    queryOneMock.mockResolvedValue({
      user_id: 20,
      project_id: 'project-allowed',
      visibility: 'private',
      label: 'temp',
    });
    hasInternalShareAccessMock.mockResolvedValue(true);

    await expect(canAccessSession('session-shared-directly', 10, 'member')).resolves.toMatchObject({ allowed: false });
  });
});


describe('company management is not a private-session or channel audience', () => {
  const privateRow = { user_id: 20, project_id: 'project-a', visibility: 'private', label: null, room_id: null };
  beforeEach(() => {
    vi.resetAllMocks();
    queryOneMock.mockResolvedValue(privateRow);
    hasInternalShareAccessMock.mockResolvedValue(false);
    isProjectMemberMock.mockResolvedValue(true);
  });

  it.each(['private', null, undefined])('denies operator for private/default visibility %s even as project member', async (visibility) => {
    queryOneMock.mockResolvedValue({ ...privateRow, visibility });
    await expect(canAccessSession('private', 10, 'operator')).resolves.toMatchObject({ allowed: false, status: 403 });
    expect(isProjectMemberMock).not.toHaveBeenCalled();
  });
  it('retains only owner access to private even with shares or admin role', async () => {
    await expect(canAccessSession('private', 20, 'operator')).resolves.toEqual({ allowed: true });
    await expect(canAccessSession('private', 10, 'admin')).resolves.toMatchObject({ allowed: false });
    hasInternalShareAccessMock.mockResolvedValue(true);
    await expect(canAccessSession('private', 10, 'operator')).resolves.toMatchObject({ allowed: false });
    await expect(canSendSessionMessage('private', 10, 'operator')).resolves.toMatchObject({ allowed: false });
  });
  it('requires ordinary project membership to read a shared conversation before administrator participation exists', async () => {
    queryOneMock.mockResolvedValue({ ...privateRow, visibility: 'project' });
    isProjectMemberMock.mockResolvedValue(false);
    await expect(canAccessSession('shared', 10, 'operator')).resolves.toMatchObject({ allowed: false });
    await expect(canInspectSessionMetadata('shared', 10, 'operator')).resolves.toMatchObject({ allowed: false });
    await expect(canMutateSessionMetadata('shared', 10, 'operator')).resolves.toMatchObject({ allowed: false });
    isProjectMemberMock.mockResolvedValue(true);
    await expect(canAccessSession('shared', 10, 'operator')).resolves.toEqual({ allowed: true });
    await expect(canWriteSessionContent('shared', 10, 'operator')).resolves.toMatchObject({ allowed: false });
  });
  it('does not expose private metadata merely because operator manages the project', async () => {
    await expect(canInspectSessionMetadata('private', 10, 'operator')).resolves.toMatchObject({ allowed: false });
  });
  it.each(['channel_ai', 'channel_agent'])('requires room membership for %s even with Agent project access or share', async (label) => {
    queryOneMock.mockResolvedValueOnce({ ...privateRow, visibility: 'project', room_id: 'room-a', label }).mockResolvedValueOnce(undefined);
    hasInternalShareAccessMock.mockResolvedValue(true);
    await expect(canAccessSession('channel', 10, 'operator')).resolves.toMatchObject({ allowed: false, status: 403 });
    expect(isProjectMemberMock).not.toHaveBeenCalled();
    expect(hasInternalShareAccessMock).not.toHaveBeenCalled();
    queryOneMock.mockResolvedValueOnce({ ...privateRow, visibility: 'project', room_id: 'room-a', label }).mockResolvedValueOnce({ ok: 1 });
    await expect(canAccessSession('channel', 10, 'operator')).resolves.toEqual({ allowed: true });
  });
  it('checks the channel itself rather than accepting company role', async () => {
    queryOneMock.mockResolvedValue({ exists: true, is_member: false });
    await expect(canAccessRoom('room-a', 10, 'operator')).resolves.toMatchObject({ allowed: false });
    queryOneMock.mockResolvedValue({ exists: true, is_member: true });
    await expect(canAccessRoom('room-a', 10, 'operator')).resolves.toEqual({ allowed: true });
  });
  it('fails closed for orphaned project-less channel AI', async () => {
    queryOneMock.mockResolvedValue({ ...privateRow, project_id: null, user_id: null, label: 'channel_ai' });
    await expect(canAccessSession('orphan', 10, 'member')).resolves.toMatchObject({ allowed: false });
  });
  it('returns 404 for nonexistent sessions even to admin/operator', async () => {
    queryOneMock.mockResolvedValue(undefined);
    for (const role of ['admin', 'operator']) {
      await expect(canAccessSession('missing', 10, role)).resolves.toMatchObject({ allowed: false, status: 404 });
    }
  });
  it('does not let company or project ownership delete another private conversation', async () => {
    await expect(canDeleteSession('private', 10, 'operator')).resolves.toMatchObject({ allowed: false, status: 403 });
    expect(queryOneMock.mock.calls.some(([sql]) => sql.includes('FROM project_members'))).toBe(false);
  });
});

describe('Agent use never promotes read-only roles or memberships', () => {
  beforeEach(() => vi.resetAllMocks());
  it.each(['viewer', 'guest', 'unknown'])('denies %s creation and even owned-session send', async (role) => {
    queryOneMock.mockResolvedValue({ user_id: 10 });
    await expect(canCreateInProject(null, 10, role)).resolves.toMatchObject({ allowed: false });
    await expect(canCreateInProject('project-a', 10, role)).resolves.toMatchObject({ allowed: false });
    await expect(canSendSessionMessage('owned', 10, role)).resolves.toMatchObject({ allowed: false, reason: 'readonly_role' });
  });
  it.each(['viewer', 'guest', 'read', undefined])('denies member creation with membership role %s', async (role) => {
    queryOneMock.mockResolvedValue(role ? { role } : undefined);
    await expect(canCreateInProject('project-a', 10, 'member')).resolves.toMatchObject({ allowed: false });
  });
  it.each(['member', 'owner'])('allows creation for writable membership %s', async (role) => {
    queryOneMock.mockResolvedValue({ role });
    await expect(canCreateInProject('project-a', 10, 'member')).resolves.toEqual({ allowed: true });
  });
  it('allows invited operator to use the same Agent without cross-owner send', async () => {
    queryOneMock.mockResolvedValue({ role: 'member' });
    await expect(canCreateInProject('project-a', 10, 'operator')).resolves.toEqual({ allowed: true });
    queryOneMock.mockResolvedValue({ user_id: 20 });
    await expect(canSendSessionMessage('other', 10, 'operator')).resolves.toMatchObject({ allowed: false });
  });
});


describe('administrator participation adds only the exact non-private audience', () => {
  const shared = { user_id: 20, project_id: 'project-a', visibility: 'project', room_id: null, label: null };
  beforeEach(() => { vi.resetAllMocks(); isProjectMemberMock.mockResolvedValue(false); hasInternalShareAccessMock.mockResolvedValue(false); });
  it('ignores legacy participation for shared and private reads', async () => {
    queryOneMock.mockResolvedValueOnce(shared).mockResolvedValueOnce({ allowed: true });
    expect(await canAccessSession('shared', 10, 'operator')).toMatchObject({ allowed: false });
    queryOneMock.mockResolvedValue({ ...shared, visibility: 'private' });
    expect(await canAccessSession('private', 10, 'operator')).toMatchObject({ allowed: false });
    expect(await canSendSessionMessage('private', 10, 'operator')).toMatchObject({ allowed: false });
  });
  it('does not use project participation for a channel conversation', async () => {
    queryOneMock.mockResolvedValueOnce({ ...shared, room_id: 'room-a', label: 'channel_ai' })
      .mockResolvedValueOnce(undefined).mockResolvedValueOnce({ allowed: false });
    expect(await canAccessSession('channel', 10, 'operator')).toMatchObject({ allowed: false });
    expect(queryOneMock).toHaveBeenCalledTimes(2);
    expect(queryOneMock.mock.calls.some(([sql]) => sql.includes('administrator_participations'))).toBe(false);
  });
  it('does not consult participation for a downgraded member', async () => {
    queryOneMock.mockResolvedValueOnce(shared).mockResolvedValueOnce(undefined);
    expect(await canAccessSession('shared', 10, 'member')).toMatchObject({ allowed: false });
    expect(queryOneMock).toHaveBeenCalledTimes(1);
  });
});

describe('shared Agent conversation participation', () => {
  beforeEach(() => vi.resetAllMocks());
  it.each([canSendSessionMessage, canWriteSessionContent])('allows a current writable invited member', async (authorize) => {
    queryOneMock.mockResolvedValueOnce({ user_id: 20 })
      .mockResolvedValueOnce({ project_id: 'shared-agent', visibility: 'project', room_id: null })
      .mockResolvedValueOnce({ role: 'member' });
    await expect(authorize('shared', 10, 'member')).resolves.toEqual({ allowed: true, reason: 'project_participant' });
    expect(queryOneMock.mock.calls[2][0]).toContain('u.disabled = 0');
    expect(queryOneMock.mock.calls[2][0]).toContain('COALESCE(p.archived, 0) = 0');
  });
  it.each([undefined, { role: 'viewer' }])('denies absent or read-only membership', async (membership) => {
    queryOneMock.mockResolvedValueOnce({ user_id: 20 })
      .mockResolvedValueOnce({ project_id: 'shared-agent', visibility: 'project', room_id: null })
      .mockResolvedValueOnce(membership);
    await expect(canSendSessionMessage('shared', 10, 'member')).resolves.toMatchObject({ allowed: false });
  });
  it.each([
    { project_id: 'agent', visibility: 'private', room_id: null },
    { project_id: 'agent', visibility: 'project', room_id: 'channel' },
    { project_id: null, visibility: 'project', room_id: null },
  ])('does not extend private, channel or projectless access', async (session) => {
    queryOneMock.mockResolvedValueOnce({ user_id: 20 }).mockResolvedValueOnce(session);
    await expect(canWriteSessionContent('shared', 10, 'member')).resolves.toMatchObject({ allowed: false });
    expect(queryOneMock).toHaveBeenCalledTimes(2);
  });
  it('keeps destructive administration owner-only', async () => {
    queryOneMock.mockResolvedValue({ user_id: 20, project_id: 'agent', visibility: 'project' });
    await expect(canAdministerSession('shared', 10, 'member')).resolves.toMatchObject({ allowed: false });
    expect(queryOneMock).toHaveBeenCalledTimes(1);
  });
});

describe('invite-only content for every role', () => {
  beforeEach(() => { vi.resetAllMocks(); isProjectMemberMock.mockResolvedValue(false); });
  it.each(['admin', 'operator', 'member', 'viewer'])('denies %s without an invitation and denies private even with invitation', async role => {
    queryOneMock.mockResolvedValue({ user_id: 20, project_id: 'agent', visibility: 'project' });
    expect((await canAccessSession('shared', 10, role)).allowed).toBe(false);
    isProjectMemberMock.mockResolvedValue(true);
    expect((await canAccessSession('shared', 10, role)).allowed).toBe(true);
    queryOneMock.mockResolvedValue({ user_id: 20, project_id: 'agent', visibility: 'private' });
    expect((await canAccessSession('private', 10, role)).allowed).toBe(false);
    expect((await canInspectSessionMetadata('private', 10, role)).allowed).toBe(false);
  });
});

describe('former Project member direct access', () => {
  beforeEach(() => { vi.resetAllMocks(); isProjectMemberMock.mockResolvedValue(false); });
  it.each(['operator', 'member'])('blocks an owned Project session for %s without membership', async (role) => {
    queryOneMock.mockResolvedValueOnce({ user_id: 10, project_id: 'p', visibility: 'private' }).mockResolvedValueOnce(undefined);
    expect(await canAccessSession('owned', 10, role)).toMatchObject({ allowed: false, status: 403 });
  });
});

describe('active admin Project membership exception', () => {
  beforeEach(() => { vi.resetAllMocks(); isProjectMemberMock.mockResolvedValue(false); });
  it('allows an active admin but denies an inactive admin without membership', async () => {
    const row = { user_id: 20, project_id: 'p', visibility: 'project' };
    queryOneMock.mockResolvedValueOnce(row).mockResolvedValueOnce({ ok: 1 });
    expect(await canAccessSession('shared', 10, 'admin')).toEqual({ allowed: true });
    queryOneMock.mockResolvedValueOnce(row).mockResolvedValueOnce(undefined);
    expect(await canAccessSession('shared', 10, 'admin')).toMatchObject({ allowed: false });
  });
});
