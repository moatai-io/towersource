import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ queryOne: vi.fn(), member: vi.fn(), gate: vi.fn(), share: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ queryOne: mocks.queryOne }));
vi.mock('./project-membership-manager.js', () => ({ isProjectMember: mocks.member, getAccessibleProjectIds: vi.fn() }));
vi.mock('../session/session-share-manager.js', () => ({ hasInternalShareAccess: mocks.share }));
vi.mock('./team-session-policy.js', () => ({ resolveTeamSessionGate: mocks.gate }));

import { canAccessSession, canSendSessionMessage, canWriteSessionContent, canAdministerSession, canMutateSessionMetadata } from './project-access.js';

const actorId = 10;
const sessionId = 'session-a';
const projectId = 'project-a';
let row: { user_id: number; project_id: string | null; visibility: string; room_id: string | null; label: string | null };
let membership = false;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '1');
  row = { user_id: actorId, project_id: projectId, visibility: 'private', room_id: null, label: null };
  membership = false;
  mocks.member.mockImplementation(async () => membership);
  mocks.gate.mockImplementation(async input => ({ kind: 'team', ownerAdmission: input.sessionOwnerId === input.userId }));
  mocks.share.mockResolvedValue(false);
  mocks.queryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM sessions WHERE id = $1')) return row;
    if (sql.includes('FROM project_members pm')) return membership ? { role: 'member' } : undefined;
    if (sql.includes('FROM room_members')) return { ok: 1 };
    if (sql.includes('SELECT 1 AS ok WHERE')) return { ok: 1 };
    throw new Error(`Unexpected fixture query: ${sql}`);
  });
});
afterEach(() => vi.unstubAllEnvs());

const actions = [
  ['read', canAccessSession], ['send', canSendSessionMessage], ['content', canWriteSessionContent],
  ['admin', canAdministerSession], ['metadata', canMutateSessionMetadata],
] as const;

describe('current team read and action admission — no legacy revocation bypass', () => {
  it.each(actions)('admits a valid team owner %s without Project membership', async (name, authorize) => {
    expect(await authorize(sessionId, actorId, 'member')).toMatchObject({ allowed: true });
    const expectedInput = { userId: actorId, sessionOwnerId: actorId, agentProjectId: projectId, channelBound: false };
    expect(mocks.gate).toHaveBeenCalledWith(expectedInput);
    expect(mocks.member).not.toHaveBeenCalled();
  });

  it.each(['read', 'send', 'content'] as const)('does not grant a team nonowner %s without existing audience', async action => {
    row.user_id = 20;
    row.visibility = 'project';
    const authorize = actions.find(([name]) => name === action)![1];
    expect(await authorize(sessionId, actorId, 'member')).toMatchObject({ allowed: false, status: 403 });
    expect(mocks.gate).toHaveBeenCalledTimes(1);
  });

  it.each(['read', 'send', 'content'] as const)('preserves a team nonowner %s with existing writable membership', async action => {
    row.user_id = 20;
    row.visibility = 'project';
    membership = true;
    const authorize = actions.find(([name]) => name === action)![1];
    expect(await authorize(sessionId, actorId, 'member')).toMatchObject({ allowed: true });
    expect(mocks.gate).toHaveBeenCalledTimes(1);
  });

  describe.each(actions)('%s revocation and failures', (name, authorize) => {
    it.each([10, 20])('blocks revoked use despite retained Project membership (owner=%s)', async ownerId => {
      row.user_id = ownerId;
      row.visibility = 'project';
      membership = true;
      mocks.share.mockResolvedValue(true);
      mocks.gate.mockRejectedValue(new Error('TEAM_WORKSPACE_ACCESS_DENIED'));
      const result = await authorize(sessionId, actorId, 'member');
      expect(result).toMatchObject({ allowed: false, status: 403 });
      if (name !== 'read') expect(result).toHaveProperty('reason', 'team_access_denied');
      expect(mocks.share).not.toHaveBeenCalled();
      expect(mocks.member).not.toHaveBeenCalled();
      expect(mocks.queryOne).toHaveBeenCalledTimes(1);
    });

    it('maps only the expected invalid-context error to 403', async () => {
      mocks.gate.mockRejectedValue(new Error('TEAM_WORKSPACE_CONTEXT_REQUIRED'));
      expect(await authorize(sessionId, actorId, 'member')).toMatchObject({ allowed: false, status: 403 });
    });

    it('propagates missing schema / DB failure without legacy fallback', async () => {
      membership = true;
      const failure = Object.assign(new Error('relation does not exist'), { code: '42P01' });
      mocks.gate.mockRejectedValue(failure);
      await expect(authorize(sessionId, actorId, 'member')).rejects.toBe(failure);
      expect(mocks.member).not.toHaveBeenCalled();
    });

    it('never treats an unexpected resolver error as a legacy grant', async () => {
      const failure = new Error('unexpected context failure');
      mocks.gate.mockRejectedValue(failure);
      await expect(authorize(sessionId, actorId, 'member')).rejects.toBe(failure);
    });
  });

  it('keeps the default unset rollout guard off', async () => {
    vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', undefined);
    expect(await canAccessSession(sessionId, actorId, 'member')).toMatchObject({ allowed: false, status: 403 });
    expect(await canSendSessionMessage(sessionId, actorId, 'member')).toMatchObject({ allowed: true });
    expect(mocks.gate).not.toHaveBeenCalled();
  });

  it.each(['0', 'true', ''])('does not query team schema without exact server opt-in (%s)', async value => {
    vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', value);
    expect(await canAccessSession(sessionId, actorId, 'member')).toMatchObject({ allowed: false, status: 403 });
    expect(await canSendSessionMessage(sessionId, actorId, 'member')).toMatchObject({ allowed: true });
    expect(mocks.gate).not.toHaveBeenCalled();
  });

  it('preserves confirmed teamless legacy behavior while enabled', async () => {
    mocks.gate.mockResolvedValue({ kind: 'legacy' });
    expect(await canAccessSession(sessionId, actorId, 'member')).toMatchObject({ allowed: false, status: 403 });
    expect(await canSendSessionMessage(sessionId, actorId, 'member')).toMatchObject({ allowed: true });
    membership = true;
    expect(await canAccessSession(sessionId, actorId, 'member')).toMatchObject({ allowed: true });
  });

  it.each(['channel_agent', 'channel_ai'])('excludes room-bound %s from the team gate', async label => {
    row.room_id = 'room-a';
    row.label = label;
    for (const [, authorize] of actions) expect(await authorize(sessionId, actorId, 'member')).toMatchObject({ allowed: true });
    expect(mocks.gate).not.toHaveBeenCalled();
    row.user_id = 20;
    row.visibility = 'project';
    expect(await canAccessSession(sessionId, actorId, 'member')).toMatchObject({ allowed: true });
    expect(mocks.gate).not.toHaveBeenCalled();
  });

  it.each([null, 'spawned'])('does not exclude a room alone from revocation (label=%s)', async label => {
    row.room_id = 'room-a';
    row.label = label;
    mocks.gate.mockRejectedValue(new Error('TEAM_WORKSPACE_ACCESS_DENIED'));
    for (const [, authorize] of actions) expect(await authorize(sessionId, actorId, 'member')).toMatchObject({ allowed: false, status: 403 });
    expect(mocks.gate).toHaveBeenCalledTimes(actions.length);
  });

  it('does not exclude a channel label without a room', async () => {
    row.label = 'channel_agent';
    mocks.gate.mockRejectedValue(new Error('TEAM_WORKSPACE_ACCESS_DENIED'));
    expect(await canSendSessionMessage(sessionId, actorId, 'member')).toMatchObject({ allowed: false, reason: 'team_access_denied' });
  });

  it('does not require team schema for project-less Sessions', async () => {
    row.project_id = null;
    expect(await canAccessSession(sessionId, actorId, 'member')).toMatchObject({ allowed: true });
    expect(await canSendSessionMessage(sessionId, actorId, 'member')).toMatchObject({ allowed: true });
    expect(mocks.gate).not.toHaveBeenCalled();
  });

  it('prevents an existing admin shared audience from bypassing revocation', async () => {
    row.user_id = 20;
    row.visibility = 'project';
    mocks.gate.mockRejectedValue(new Error('TEAM_WORKSPACE_ACCESS_DENIED'));
    expect(await canAccessSession(sessionId, actorId, 'admin')).toMatchObject({ allowed: false, status: 403 });
    expect(mocks.gate).toHaveBeenCalledTimes(1);
  });

  it('checks current use again after the owner loses membership', async () => {
    expect(await canAccessSession(sessionId, actorId, 'member')).toMatchObject({ allowed: true });
    mocks.gate.mockRejectedValue(new Error('TEAM_WORKSPACE_ACCESS_DENIED'));
    expect(await canAccessSession(sessionId, actorId, 'member')).toMatchObject({ allowed: false, status: 403 });
    expect(await canSendSessionMessage(sessionId, actorId, 'member')).toMatchObject({ allowed: false, reason: 'team_access_denied' });
  });

  it.each(['viewer', 'guest', 'unknown'])('never upgrades a read-only/unknown %s owner to executable', async role => {
    expect(await canSendSessionMessage(sessionId, actorId, role)).toMatchObject({ allowed: false, reason: 'readonly_role' });
    expect(mocks.gate).not.toHaveBeenCalled();
  });

  it('keeps another owner private Session unreadable despite team use and Project membership', async () => {
    row.user_id = 20;
    membership = true;
    expect(await canAccessSession(sessionId, actorId, 'member')).toMatchObject({ allowed: false, status: 403 });
    expect(await canSendSessionMessage(sessionId, actorId, 'member')).toMatchObject({ allowed: false, reason: 'owner_mismatch' });
  });
});
