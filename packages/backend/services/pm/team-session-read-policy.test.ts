import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ queryOne: vi.fn(), member: vi.fn(), gate: vi.fn(), own: vi.fn(), share: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ queryOne: mocks.queryOne }));
vi.mock('./project-membership-manager.js', () => ({ isProjectMember: mocks.member, getAccessibleProjectIds: vi.fn() }));
vi.mock('./team-session-policy.js', () => ({ resolveTeamSessionGate: mocks.gate, canUseOwnTeamSession: mocks.own }));
vi.mock('../session/session-share-manager.js', () => ({ hasInternalShareAccess: mocks.share }));

import { canAccessSession } from './project-access.js';

let row: { user_id: number; project_id: string | null; visibility: string; room_id: string | null; label: string | null };
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '1');
  row = { user_id: 10, project_id: 'agent-a', visibility: 'private', room_id: null, label: null };
  mocks.queryOne.mockImplementation(async (sql: string) => sql.includes('FROM sessions') ? row : undefined);
  mocks.member.mockResolvedValue(false);
  mocks.gate.mockRejectedValue(new Error('TEAM_WORKSPACE_ACCESS_DENIED'));
  mocks.own.mockRejectedValue(new Error('TEAM_WORKSPACE_ACCESS_DENIED'));
  mocks.share.mockResolvedValue(false);
});
afterEach(() => vi.unstubAllEnvs());

function expectNoTeamResolution() {
  expect(mocks.gate).not.toHaveBeenCalled();
  expect(mocks.own).not.toHaveBeenCalled();
}

describe('current team use before existing read audience', () => {
  it.each([10, 20])('denies Project read after team removal (owner=%s)', async ownerId => {
    row.user_id = ownerId;
    row.visibility = ownerId === 10 ? 'private' : 'project';
    mocks.member.mockResolvedValue(true);
    expect(await canAccessSession('s', 10, 'member')).toMatchObject({ allowed: false, status: 403 });
    expect(mocks.gate).toHaveBeenCalledTimes(1);
  });

  it.each(['member', 'operator'])('does not give a team-only nonowner audience for %s', async role => {
    row.user_id = 20;
    row.visibility = 'project';
    mocks.gate.mockResolvedValue({ kind: 'team', ownerAdmission: false });
    expect(await canAccessSession('s', 10, role)).toMatchObject({ allowed: false, status: 403 });
    expect(mocks.gate).toHaveBeenCalledTimes(1);
  });

  it('does not resolve a nonowner private conversation', async () => {
    row.user_id = 20;
    expect(await canAccessSession('s', 10, 'member')).toMatchObject({ allowed: false, status: 403 });
    expectNoTeamResolution();
  });

  it('denies admin shared read after team admission revocation', async () => {
    row.user_id = 20;
    row.visibility = 'project';
    mocks.queryOne.mockImplementation(async (sql: string) => sql.includes('FROM sessions') ? row : { ok: 1 });
    expect(await canAccessSession('s', 10, 'admin')).toMatchObject({ allowed: false, status: 403 });
    expect(mocks.gate).toHaveBeenCalledTimes(1);
  });

  it('admits a new team owner with no Project membership', async () => {
    mocks.gate.mockResolvedValue({ kind: 'team', ownerAdmission: true });
    expect(await canAccessSession('s', 10, 'member')).toEqual({ allowed: true });
    expect(mocks.gate).toHaveBeenCalledExactlyOnceWith({ userId: 10, sessionOwnerId: 10, agentProjectId: 'agent-a', channelBound: false });
  });

  it('rechecks the current team path after team admission is removed', async () => {
    mocks.gate.mockResolvedValueOnce({ kind: 'team', ownerAdmission: true }).mockRejectedValueOnce(new Error('TEAM_WORKSPACE_ACCESS_DENIED'));
    expect(await canAccessSession('s', 10, 'member')).toEqual({ allowed: true });
    expect(await canAccessSession('s', 10, 'member')).toMatchObject({ allowed: false, status: 403 });
    expect(mocks.gate).toHaveBeenCalledTimes(2);
  });

  it.each(['member', 'operator', 'admin'])('propagates team DB failure despite existing Project audience (%s)', async role => {
    row.user_id = 20;
    row.visibility = 'project';
    mocks.member.mockResolvedValue(true);
    mocks.own.mockRejectedValue(new Error('team database unavailable'));
    mocks.gate.mockRejectedValue(new Error('team database unavailable'));
    await expect(canAccessSession('s', 10, role)).rejects.toThrow('team database unavailable');
  });

  it.each([null, 'spawned'])('does not mistake a room alone for a channel (label=%s)', async label => {
    row.room_id = 'room-a';
    row.label = label;
    mocks.gate.mockResolvedValue({ kind: 'team', ownerAdmission: true });
    expect(await canAccessSession('s', 10, 'member')).toEqual({ allowed: true });
    expect(mocks.gate).toHaveBeenCalledTimes(1);
  });

  it('denies a confirmed teamless owner with no existing grant', async () => {
    mocks.gate.mockResolvedValue({ kind: 'legacy' });
    expect(await canAccessSession('s', 10, 'member')).toMatchObject({ allowed: false, status: 403 });
  });

  it.each(['TEAM_WORKSPACE_ACCESS_DENIED', 'TEAM_WORKSPACE_CONTEXT_REQUIRED'])('maps current team-path policy failure to 403: %s', async message => {
    mocks.gate.mockRejectedValue(new Error(message));
    expect(await canAccessSession('s', 10, 'member')).toMatchObject({ allowed: false, status: 403 });
  });

  it('propagates DB failure in the current team path', async () => {
    const failure = new Error('database unavailable');
    mocks.gate.mockRejectedValue(failure);
    await expect(canAccessSession('s', 10, 'member')).rejects.toBe(failure);
  });

  it.each([true, false])('preserves channel membership decision (member=%s)', async member => {
    row.room_id = 'room-a';
    row.label = 'channel_agent';
    row.user_id = 20;
    row.visibility = 'project';
    mocks.queryOne.mockImplementation(async (sql: string) => sql.includes('FROM sessions') ? row : member ? { ok: 1 } : undefined);
    expect((await canAccessSession('s', 10, 'member')).allowed).toBe(member);
    expectNoTeamResolution();
  });

  it('does not query team context with rollout disabled', async () => {
    vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', undefined);
    expect(await canAccessSession('s', 10, 'member')).toMatchObject({ allowed: false, status: 403 });
    expectNoTeamResolution();
  });
});
