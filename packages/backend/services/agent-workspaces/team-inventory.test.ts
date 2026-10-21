import { beforeEach, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ queryOne: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => db);
import { listCurrentTeamWorkspaces as listTeamAgentWorkspaces } from './team-inventory.js';
const input = { userId: 1, agentProjectId: 'agent-a' };
const workspace = { workspaceId: 'w-c', ownerProjectId: 'agent-c', teamId: 'sales', registered: true, active: true };
const facts = { user_role: 'member', user_active: true, agent_active: true, team_id: 'sales', team_member: true, workspaces: [workspace] };
beforeEach(() => { vi.resetAllMocks(); db.queryOne.mockResolvedValue(facts); });

it('returns logical IDs only from one current authorization/inventory SQL snapshot', async () => {
  expect(await listTeamAgentWorkspaces(input)).toEqual([{ workspaceId: 'w-c', ownerProjectId: 'agent-c' }]);
  expect(db.queryOne).toHaveBeenCalledTimes(1);
  const [sql, params] = db.queryOne.mock.calls[0];
  expect(params).toEqual(['agent-a', 1]);
  expect(sql).toMatch(/source_team.team_id=tp.team_id/);
  expect(sql).toMatch(/tm.user_id=u.id/);
  expect(sql).toMatch(/LIMIT 257/);
  expect(sql).not.toMatch(/root_path|project_members|app_settings|sessions|credential/i);
});
it.each([
  { ...facts, user_active: false }, { ...facts, agent_active: false },
  { ...facts, team_member: false }, { ...facts, user_role: 'guest' },
])('rejects denied snapshot instead of publishing a stale inventory: %j', async row => {
  db.queryOne.mockResolvedValue(row);
  await expect(listTeamAgentWorkspaces(input)).rejects.toThrow('ACCESS_DENIED');
  expect(db.queryOne).toHaveBeenCalledTimes(1);
});
it('does not give teamless Agents organization-wide listing', async () => {
  db.queryOne.mockResolvedValue({ ...facts, team_id: null, workspaces: [] });
  expect(await listTeamAgentWorkspaces(input)).toBeNull();
});
it('rejects invalid account state even if Agent is teamless', async () => {
  db.queryOne.mockResolvedValue({ ...facts, team_id: null, user_active: false, workspaces: [] });
  await expect(listTeamAgentWorkspaces(input)).rejects.toThrow('ACCESS_DENIED');
});
it('fails closed on inventory overflow', async () => {
  db.queryOne.mockResolvedValue({ ...facts, workspaces: Array.from({ length: 257 }, (_, n) => ({ ...workspace, workspaceId: `w-${n}` })) });
  await expect(listTeamAgentWorkspaces(input)).rejects.toThrow('TEAM_WORKSPACE_INVENTORY_LIMIT');
});
it('returns only IDs admitted by the pure policy even with extra injected facts', async () => {
  db.queryOne.mockResolvedValue({ ...facts, workspaces: [workspace,
    { ...workspace, workspaceId: 'wrong-team', teamId: 'other' },
    { ...workspace, workspaceId: 'inactive', active: false },
    { ...workspace, workspaceId: 'unregistered', registered: false },
  ] });
  expect(await listTeamAgentWorkspaces(input)).toEqual([{ workspaceId: 'w-c', ownerProjectId: 'agent-c' }]);
});
it('allows team members with no registered active workspace to receive an empty list', async () => {
  db.queryOne.mockResolvedValue({ ...facts, workspaces: [] });
  expect(await listTeamAgentWorkspaces(input)).toEqual([]);
});
