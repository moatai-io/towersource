import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryOne } = vi.hoisted(() => ({ queryOne: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ queryOne }));

import * as teamContext from '../agent-workspaces/team-context.js';
import { canUseOwnTeamSession, resolveTeamSessionGate, resolveTeamSessionVisibility } from './team-session-policy.js';

const input = { userId: 10, sessionOwnerId: 10, agentProjectId: 'agent-a', channelBound: false };
const active = {
  // Current repository SQL snapshot DTO; detailed fact validation belongs to
  // repository/context tests and the disposable PostgreSQL audience suite.
  user_role: 'member', user_active: true, agent_active: true,
  team_id: 'team-a', team_member: true, workspaces: [],
};

beforeEach(() => {
  vi.restoreAllMocks();
  queryOne.mockReset();
  vi.spyOn(teamContext, 'resolveTeamAgentContext');
});

describe('own team Session admission (internal, not activated)', () => {
  it.each(['member', 'operator', 'admin'])('does not resolve another owner even for %s', async role => {
    queryOne.mockResolvedValue({ ...active, user_role: role });
    expect(await canUseOwnTeamSession({ ...input, sessionOwnerId: 20 })).toBe(false);
    expect(teamContext.resolveTeamAgentContext).not.toHaveBeenCalled();
    expect(queryOne).not.toHaveBeenCalled();
  });

  it.each(['member', 'operator', 'admin'])('does not resolve channel Sessions even for their %s owner', async role => {
    queryOne.mockResolvedValue({ ...active, user_role: role });
    expect(await canUseOwnTeamSession({ ...input, channelBound: true })).toBe(false);
    expect(teamContext.resolveTeamAgentContext).not.toHaveBeenCalled();
    expect(queryOne).not.toHaveBeenCalled();
  });

  it.each(['member', 'operator', 'admin'])('admits the %s owner with current team context without Project membership', async role => {
    queryOne.mockResolvedValue({ ...active, user_role: role });
    expect(await canUseOwnTeamSession(input)).toBe(true);
    expect(queryOne).toHaveBeenCalledWith(expect.any(String), ['agent-a', 10]);
  });

  it('returns false for teamless context so the caller can preserve legacy policy', async () => {
    queryOne.mockResolvedValue({ ...active, team_id: null });
    expect(await canUseOwnTeamSession(input)).toBe(false);
  });

  it.each([
    { team_member: false }, { user_active: false }, { agent_active: false }, { user_role: 'viewer' },
  ])('propagates denial for invalid current facts: %j', async patch => {
    queryOne.mockResolvedValue({ ...active, ...patch });
    await expect(canUseOwnTeamSession(input)).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it('propagates invalid team context instead of treating it as teamless', async () => {
    queryOne.mockResolvedValue({ ...active, team_id: '' });
    await expect(canUseOwnTeamSession(input)).rejects.toThrow('TEAM_WORKSPACE_CONTEXT_REQUIRED');
  });

  it('never lets admin bypass missing team membership', async () => {
    queryOne.mockResolvedValue({ ...active, user_role: 'admin', team_member: false });
    await expect(canUseOwnTeamSession(input)).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it('resolves every invocation so membership removal takes effect immediately', async () => {
    queryOne.mockResolvedValueOnce(active).mockResolvedValueOnce({ ...active, team_member: false });
    expect(await canUseOwnTeamSession(input)).toBe(true);
    await expect(canUseOwnTeamSession(input)).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
    expect(queryOne).toHaveBeenCalledTimes(2);
    expect(teamContext.resolveTeamAgentContext).toHaveBeenCalledTimes(2);
  });

  it('propagates denial for missing user or Agent facts', async () => {
    queryOne.mockResolvedValue(null);
    await expect(canUseOwnTeamSession(input)).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it('propagates invalid authenticated context without querying DB', async () => {
    for (const userId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(canUseOwnTeamSession({ ...input, userId, sessionOwnerId: userId })).rejects.toThrow('TEAM_WORKSPACE_CONTEXT_REQUIRED');
    }
    for (const agentProjectId of ['', '  ']) {
      await expect(canUseOwnTeamSession({ ...input, agentProjectId })).rejects.toThrow('TEAM_WORKSPACE_CONTEXT_REQUIRED');
    }
    expect(queryOne).not.toHaveBeenCalled();
  });

  it.each(['TEAM_WORKSPACE_ACCESS_DENIED', 'TEAM_WORKSPACE_CONTEXT_REQUIRED'])('preserves the exact resolver error: %s', async message => {
    const failure = new Error(message);
    vi.mocked(teamContext.resolveTeamAgentContext).mockRejectedValueOnce(failure);
    await expect(canUseOwnTeamSession(input)).rejects.toBe(failure);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it.each([new Error('database unavailable'), new Error('TEAM_WORKSPACE_UNKNOWN'), 'connection reset'])('propagates non-policy failure: %s', async failure => {
    queryOne.mockRejectedValue(failure);
    await expect(canUseOwnTeamSession(input)).rejects.toBe(failure);
  });
});

describe('current non-channel team Session gate (internal, not activated)', () => {
  it.each(['member', 'operator', 'admin'])('admits the %s owner without granting Project membership', async role => {
    queryOne.mockResolvedValue({ ...active, user_role: role });
    expect(await resolveTeamSessionGate(input)).toEqual({ kind: 'team', ownerAdmission: true });
    expect(teamContext.resolveTeamAgentContext).toHaveBeenCalledWith({ userId: 10, agentProjectId: 'agent-a' });
  });

  it('requires the existing audience for a nonowner despite valid team context', async () => {
    queryOne.mockResolvedValue(active);
    expect(await resolveTeamSessionGate({ ...input, sessionOwnerId: 20 })).toEqual({ kind: 'team', ownerAdmission: false });
    expect(teamContext.resolveTeamAgentContext).toHaveBeenCalledTimes(1);
  });

  it.each([10, 20, null])('returns legacy policy for confirmed teamless context (owner=%s)', async sessionOwnerId => {
    queryOne.mockResolvedValue({ ...active, team_id: null });
    expect(await resolveTeamSessionGate({ ...input, sessionOwnerId })).toEqual({ kind: 'legacy' });
  });

  it.each([10, 20])('rejects revoked team use even with an existing Project audience (owner=%s)', async sessionOwnerId => {
    queryOne.mockResolvedValue({ ...active, team_member: false });
    // Simulate the caller's already-granted legacy Project audience, NOT a team
    // DB schema. The mandatory gate must reject before that grant can be used.
    const existingProjectAudience = vi.fn().mockResolvedValue(true);
    const check = async () => {
      const gate = await resolveTeamSessionGate({ ...input, sessionOwnerId });
      if (gate.kind === 'team' && gate.ownerAdmission) return true;
      return existingProjectAudience();
    };
    await expect(check()).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
    expect(existingProjectAudience).not.toHaveBeenCalled();
  });

  it.each([10, 20])('propagates DB failure without legacy fallback (owner=%s)', async sessionOwnerId => {
    const failure = new Error('database unavailable');
    queryOne.mockRejectedValue(failure);
    await expect(resolveTeamSessionGate({ ...input, sessionOwnerId })).rejects.toBe(failure);
  });

  it('propagates invalid context instead of interpreting it as teamless', async () => {
    queryOne.mockResolvedValue({ ...active, team_id: '' });
    await expect(resolveTeamSessionGate({ ...input, sessionOwnerId: 20 })).rejects.toThrow('TEAM_WORKSPACE_CONTEXT_REQUIRED');
  });

  it.each([10, 20])('explicitly excludes channels without resolving context (owner=%s)', async sessionOwnerId => {
    expect(await resolveTeamSessionGate({ ...input, sessionOwnerId, channelBound: true })).toEqual({ kind: 'channel-excluded' });
    expect(teamContext.resolveTeamAgentContext).not.toHaveBeenCalled();
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('resolves every invocation and rejects removal for a previously admitted owner', async () => {
    queryOne.mockResolvedValueOnce(active).mockResolvedValueOnce({ ...active, team_member: false });
    expect(await resolveTeamSessionGate(input)).toEqual({ kind: 'team', ownerAdmission: true });
    await expect(resolveTeamSessionGate(input)).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
    expect(teamContext.resolveTeamAgentContext).toHaveBeenCalledTimes(2);
  });
});

describe('team Session creation visibility (pure, trusted current context)', () => {
  it('defaults a team Agent Session to private without changing the legacy default', () => {
    expect(resolveTeamSessionVisibility({ hasTeamContext: true, legacyDefault: 'project' })).toBe('private');
    expect(resolveTeamSessionVisibility({ hasTeamContext: false, legacyDefault: 'project' })).toBe('project');
    expect(resolveTeamSessionVisibility({ hasTeamContext: false, legacyDefault: 'private' })).toBe('private');
  });

  it.each(['private', 'project'] as const)('preserves explicit visibility=%s', explicitVisibility => {
    for (const hasTeamContext of [true, false]) {
      expect(resolveTeamSessionVisibility({ hasTeamContext, legacyDefault: 'private', explicitVisibility })).toBe(explicitVisibility);
    }
  });
});
