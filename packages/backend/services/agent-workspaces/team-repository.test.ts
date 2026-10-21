import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryOne } from '../../db/pg-repo.js';
import { loadTeamWorkspacePolicyInput, listCurrentTeamWorkspaceIds, requireCurrentTeamFacts } from './team-repository.js';

vi.mock('../../db/pg-repo.js', () => ({ queryOne: vi.fn() }));
const context = { userId: 1, agentProjectId: 'agent-a' };
const row = () => ({
  user_active: true, user_role: 'member', agent_active: true,
  team_id: 'team-a', team_member: true,
  workspaces: [{ workspaceId: 'wa', ownerProjectId: 'source-a', teamId: 'team-a', registered: true, active: true }],
});
beforeEach(() => { vi.resetAllMocks(); vi.mocked(queryOne).mockResolvedValue(row()); });

describe('team workspace current fact repository', () => {
  it('loads only current server facts in one SQL snapshot, with no legacy admission or Session authority', async () => {
    expect(await loadTeamWorkspacePolicyInput(context)).toEqual({
      currentUser: { active: true, role: 'member' },
      agent: { active: true, teamId: 'team-a' },
      teamMemberships: [{ teamId: 'team-a', active: true }],
      workspaces: row().workspaces,
    });
    expect(queryOne).toHaveBeenCalledTimes(1);
    const [sql, params] = vi.mocked(queryOne).mock.calls[0];
    expect(params).toEqual(['agent-a', 1]);
    expect(sql).toMatch(/agent_team_members/);
    expect(sql).toMatch(/agent_team_projects/);
    expect(sql).toMatch(/agent_workspaces/);
    expect(sql).toMatch(/approval_status\s*=\s*'active'/);
    expect(sql).toMatch(/status IN \('active',\s*'ready'\)/);
    expect(sql).not.toMatch(/status IS NULL/);
    expect(sql).toMatch(/LIMIT 257/);
    expect(sql).not.toMatch(/project_members|agent_workspace_grants|app_settings|sessions|credential|root_path|INSERT|UPDATE|DELETE/i);
  });

  it('calculates a workspace ID list through the pure policy', async () => {
    expect(await listCurrentTeamWorkspaceIds(context)).toEqual(['wa']);
  });

  it.each([
    { ...row(), team_member: false },
    { ...row(), user_active: false },
    { ...row(), agent_active: false },
    { ...row(), user_role: 'viewer' },
    { ...row(), user_role: 'guest' },
  ])('denies inadmissible current facts: %j', async facts => {
    vi.mocked(queryOne).mockResolvedValue(facts);
    await expect(listCurrentTeamWorkspaceIds(context)).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it('does not make a teamless Agent organization-wide; caller owns the legacy branch', async () => {
    vi.mocked(queryOne).mockResolvedValue({ ...row(), team_id: null, team_member: false, workspaces: [] });
    expect((await loadTeamWorkspacePolicyInput(context)).agent.teamId).toBeNull();
    await expect(listCurrentTeamWorkspaceIds(context)).rejects.toThrow('TEAM_WORKSPACE_CONTEXT_REQUIRED');
  });

  it('fails when current user or Agent Project does not exist', async () => {
    vi.mocked(queryOne).mockResolvedValue(undefined);
    await expect(loadTeamWorkspacePolicyInput(context)).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  });

  it('accepts exactly 256 inventory entries', async () => {
    const workspaces = Array.from({ length: 256 }, (_, index) => ({ ...row().workspaces[0], workspaceId: `w-${index}` }));
    vi.mocked(queryOne).mockResolvedValue({ ...row(), workspaces });
    expect(await listCurrentTeamWorkspaceIds(context)).toEqual(workspaces.map(workspace => workspace.workspaceId));
  });

  it('rejects the overflow sentinel instead of returning a truncated inventory', async () => {
    const workspaces = Array.from({ length: 257 }, (_, index) => ({ ...row().workspaces[0], workspaceId: `w-${index}` }));
    vi.mocked(queryOne).mockResolvedValue({ ...row(), workspaces });
    await expect(loadTeamWorkspacePolicyInput(context)).rejects.toThrow('TEAM_WORKSPACE_INVENTORY_LIMIT');
  });

  it('loads context without inventory SQL or overflow checking', async () => {
    // Real SQL returns [] here; even an unexpected inventory payload cannot impose context's cap.
    vi.mocked(queryOne).mockResolvedValue({ ...row(), workspaces: Array.from({ length: 257 }, () => row().workspaces[0]) });
    const facts = await loadTeamWorkspacePolicyInput(context, { includeInventory: false });
    expect(facts.agent.teamId).toBe('team-a');
    expect(facts.workspaces).toEqual([]);
    expect(vi.mocked(queryOne).mock.calls[0][0]).not.toMatch(/agent_workspaces|LIMIT 257|jsonb_agg/);
  });

  it.each(['viewer', 'guest'])('preserves teamless %s eligibility without allowing a team inventory', async role => {
    vi.mocked(queryOne).mockResolvedValue({ ...row(), user_role: role, team_id: null, team_member: false, workspaces: [] });
    const facts = await loadTeamWorkspacePolicyInput(context, { includeInventory: false });
    expect(() => requireCurrentTeamFacts(facts)).not.toThrow();
    await expect(listCurrentTeamWorkspaceIds(context)).rejects.toThrow('TEAM_WORKSPACE_CONTEXT_REQUIRED');
  });

  it('does not cache membership or inventory between calls', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(row()).mockResolvedValueOnce({ ...row(), team_member: false });
    expect(await listCurrentTeamWorkspaceIds(context)).toEqual(['wa']);
    await expect(listCurrentTeamWorkspaceIds(context)).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
    expect(queryOne).toHaveBeenCalledTimes(2);
  });

  it.each([
    { userId: 0, agentProjectId: 'a' },
    { userId: 1.5, agentProjectId: 'a' },
    { userId: Number.MAX_SAFE_INTEGER + 1, agentProjectId: 'a' },
    { userId: 1, agentProjectId: '' },
    { userId: 1, agentProjectId: '  ' },
    { userId: 1, agentProjectId: 'a'.repeat(201) },
  ])('rejects invalid trusted context before SQL: %j', async input => {
    await expect(loadTeamWorkspacePolicyInput(input)).rejects.toThrow('TEAM_WORKSPACE_CONTEXT_REQUIRED');
    expect(queryOne).not.toHaveBeenCalled();
  });
});
