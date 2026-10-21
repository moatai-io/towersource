import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), gate: vi.fn(), member: vi.fn(), messages: vi.fn(), audience: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ query: m.query, queryOne: m.queryOne, execute: m.execute }));
vi.mock('../pm/team-session-policy.js', () => ({ resolveTeamSessionGate: m.gate }));
vi.mock('../pm/session-audience.js', () => ({ sessionAudienceSql: m.audience }));
vi.mock('../message-store.js', () => ({ getMessages: m.messages }));
import { createInternalSessionShare, createExternalSessionShare, getSessionSharesWithMe, getSharesBySession, hasInternalShareAccess, getSessionShareByToken } from './session-share-manager.js';

const session = { id: 'session', name: 'Conversation', user_id: 1, project_id: 'agent', visibility: 'project', room_id: null };
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '1');
  m.queryOne.mockImplementation(async (sql, params) => {
    if (sql.includes('FROM sessions WHERE')) return session;
    if (sql.includes('FROM project_members')) return await m.member(params[0], params[1]) ? { ok: 1 } : null;
    if (sql.includes('SELECT 1 FROM session_shares')) return { ok: 1 };
    return null;
  });
  m.query.mockResolvedValue([]);
  m.member.mockResolvedValue(true);
  // Team access has been revoked. Existing conversation approval must remain independent.
  m.gate.mockRejectedValue(new Error('TEAM_WORKSPACE_ACCESS_DENIED'));
  m.messages.mockResolvedValue([{ role: 'user', content: 'synthetic', created_at: 'date' }]);
  m.audience.mockReturnValue('FALSE');
});
afterEach(() => vi.unstubAllEnvs());

describe('existing Session sharing remains independent of team admission', () => {
  it.each(['0', '1'])('retains owner and explicit target Project approval with rollout=%s', async enabled => {
    vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', enabled);
    await createInternalSessionShare('session', 1, 2);
    expect(m.member).toHaveBeenCalledExactlyOnceWith('agent', 2);
    expect(m.execute).toHaveBeenCalledTimes(1);
    expect(m.gate).not.toHaveBeenCalled();
  });

  it('never substitutes team membership for target Project approval', async () => {
    m.gate.mockResolvedValue({ kind: 'team', ownerAdmission: false });
    m.member.mockResolvedValue(false);
    await expect(createInternalSessionShare('session', 1, 2)).rejects.toThrow('Invite this user to the Agent');
    expect(m.execute).not.toHaveBeenCalled();
    expect(m.gate).not.toHaveBeenCalled();
  });

  it.each(['private', 'company'])('preserves rejection of %s sharing', async visibility => {
    m.queryOne.mockResolvedValue({ ...session, visibility });
    await expect(createInternalSessionShare('session', 1, 2)).rejects.toThrow('Agent-shared before sharing it');
    expect(m.execute).not.toHaveBeenCalled();
    expect(m.gate).not.toHaveBeenCalled();
  });

  it('preserves owner-only sharing', async () => {
    await expect(createExternalSessionShare('session', 2, '24h')).rejects.toThrow('Only session owner');
    expect(m.messages).not.toHaveBeenCalled();
  });

  it.each([{ project_id: null }, { room_id: 'room' }])('preserves unsupported conversation rejection: %j', async binding => {
    m.queryOne.mockResolvedValue({ ...session, ...binding });
    await expect(createExternalSessionShare('session', 1, '24h')).rejects.toThrow('Agent-shared before sharing it');
    expect(m.messages).not.toHaveBeenCalled();
  });

  it('retains snapshot creation after team revocation without adding Project owner requirements', async () => {
    await createExternalSessionShare('session', 1, '24h');
    expect(m.messages).toHaveBeenCalledExactlyOnceWith('session');
    expect(m.execute).toHaveBeenCalledTimes(1);
    expect(m.member).not.toHaveBeenCalled();
    expect(m.gate).not.toHaveBeenCalled();
  });

  it('propagates existing sharing database failures', async () => {
    const error = new Error('database unavailable');
    m.member.mockRejectedValue(error);
    await expect(createInternalSessionShare('session', 1, 2)).rejects.toBe(error);
    expect(m.execute).not.toHaveBeenCalled();
  });
});

describe('explicit shares and their lists retain legacy behavior', () => {
  it.each([
    ['with-me', () => getSessionSharesWithMe(2)],
    ['by-session', () => getSharesBySession('session', 1)],
  ] as const)('preserves exact on/off query and result for %s', async (_name, list) => {
    const rows = [{ id: 'explicit-share' }];
    m.query.mockResolvedValue(rows);
    expect(await list()).toBe(rows);
    const enabledCall = m.query.mock.calls[0];
    vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '0');
    expect(await list()).toBe(rows);
    expect(m.query.mock.calls[1]).toEqual(enabledCall);
    expect(enabledCall[0]).not.toContain('agent_team');
    expect(m.audience).not.toHaveBeenCalled();
    expect(m.gate).not.toHaveBeenCalled();
  });

  it.each([true, false])('requires an actual unrevoked explicit share, present=%s', async exists => {
    m.queryOne.mockResolvedValue(exists ? { ok: 1 } : null);
    expect(await hasInternalShareAccess('session', 2)).toBe(exists);
    expect(m.queryOne).toHaveBeenCalledTimes(1);
    const [sql, params] = m.queryOne.mock.calls[0];
    expect(sql).toContain('target_user_id = $2');
    expect(sql).toContain("share_type = 'internal'");
    expect(sql).toContain('revoked = 0');
    expect(params).toEqual(['session', 2]);
    expect(m.gate).not.toHaveBeenCalled();
    expect(m.audience).not.toHaveBeenCalled();
  });

  it('preserves the exact live-share lookup on/off without team or Session prerequisite queries', async () => {
    expect(await hasInternalShareAccess('session', 2)).toBe(true);
    const enabledCall = m.queryOne.mock.calls[0];
    vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '0');
    expect(await hasInternalShareAccess('session', 2)).toBe(true);
    expect(m.queryOne.mock.calls).toEqual([enabledCall, enabledCall]);
    expect(enabledCall[0]).not.toContain('JOIN sessions');
  });

  it('propagates failures of actual share and metadata queries', async () => {
    const error = new Error('database unavailable');
    m.queryOne.mockRejectedValue(error); m.query.mockRejectedValue(error);
    await expect(hasInternalShareAccess('session', 2)).rejects.toBe(error);
    await expect(getSessionSharesWithMe(2)).rejects.toBe(error);
    await expect(getSharesBySession('session', 1)).rejects.toBe(error);
  });

  it('does not revoke or re-resolve previously exported external snapshots', async () => {
    const snapshot = { share_type: 'external', revoked: 0, snapshot_json: '{"messages":[]}', expires_at: null };
    m.queryOne.mockResolvedValue(snapshot);
    expect(await getSessionShareByToken('existing-token')).toEqual(snapshot);
    expect(m.gate).not.toHaveBeenCalled();
    expect(m.execute).not.toHaveBeenCalled();
  });
});
