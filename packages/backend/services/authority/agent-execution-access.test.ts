import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const team = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../agent-workspaces/team-context.js', () => ({ resolveTeamAgentContext: team.resolve }));
afterEach(() => vi.unstubAllEnvs());
const db = vi.hoisted(() => ({ queryOne: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => db);
import { requireCurrentAgentExecutionAccess } from './agent-execution-access.js';
const row = { role: 'member', disabled: 0, archived: 0, membership_role: 'member', agent_status: 'active' };
const input = { projectId: 'project-a', userId: 7 };
beforeEach(() => { vi.resetAllMocks(); db.queryOne.mockResolvedValue(row); });
describe('current Agent entrance facts', () => {
  it('uses current facts and returns no personal provider identity', async () => {
    expect(await requireCurrentAgentExecutionAccess(input)).toEqual({ userRole: 'member', projectMember: true, projectOwner: false, projectWritable: true, executionScope: 'project' });
    expect(db.queryOne).toHaveBeenCalledWith(expect.stringContaining('LEFT JOIN project_members'), ['project-a', 7]);
  });
  it.each([
    undefined, { ...row, disabled: 1 }, { ...row, archived: 1 }, { ...row, agent_status: 'paused' },
    { ...row, role: 'viewer' }, { ...row, role: 'guest' }, { ...row, role: 'unknown' },
    { ...row, membership_role: 'viewer' }, { ...row, membership_role: null },
  ])('rejects revoked/inactive facts %j', async current => {
    db.queryOne.mockResolvedValue(current);
    await expect(requireCurrentAgentExecutionAccess(input)).rejects.toThrow(/AGENT_EXECUTION_(INACTIVE|ACCESS_DENIED)/);
  });
  it.each(['admin', 'operator'])('denies uninvited %s without synthesizing membership', async role => {
    db.queryOne.mockResolvedValue({ ...row, role, membership_role: null });
    await expect(requireCurrentAgentExecutionAccess(input)).rejects.toThrow('AGENT_EXECUTION_ACCESS_DENIED');
  });
  it('fails closed on DB failure', async () => {
    db.queryOne.mockRejectedValue(new Error('synthetic-db-unavailable'));
    await expect(requireCurrentAgentExecutionAccess(input)).rejects.toThrow('synthetic-db-unavailable');
  });
  it.each(['admin', 'operator'])('allows explicitly invited %s execution', async (role) => {
    db.queryOne.mockResolvedValue({ ...row, role });
    expect(await requireCurrentAgentExecutionAccess(input)).toMatchObject({
      userRole: role, projectMember: true, projectWritable: true,
    });
  });
});

it('rejects retired organization admission before querying any authority', async () => {
  await expect(requireCurrentAgentExecutionAccess({ ...input, executionScope: 'organization' })).rejects.toThrow('EXECUTION_SCOPE_UNSUPPORTED');
  expect(db.queryOne).not.toHaveBeenCalled();
  expect(team.resolve).not.toHaveBeenCalled();
});
it('does not query obsolete organization settings for Project execution', async () => {
  await requireCurrentAgentExecutionAccess(input);
  expect(db.queryOne.mock.calls[0][0]).not.toContain('app_settings');
});

it('never executes a team Agent through the legacy Project or host path', async () => {
  vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '1');
  team.resolve.mockResolvedValue({ teamId: 'sales', agentProjectId: input.projectId, userId: input.userId });
  await expect(requireCurrentAgentExecutionAccess(input)).rejects.toThrow('TEAM_EXECUTOR_NOT_READY');
  expect(db.queryOne).not.toHaveBeenCalled();
});
it('does not fall back to Project membership after team revocation', async () => {
  vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '1');
  team.resolve.mockRejectedValue(new Error('TEAM_WORKSPACE_ACCESS_DENIED'));
  await expect(requireCurrentAgentExecutionAccess(input)).rejects.toThrow('TEAM_WORKSPACE_ACCESS_DENIED');
  expect(db.queryOne).not.toHaveBeenCalled();
});
it('preserves legacy execution only for confirmed teamless Agents', async () => {
  vi.stubEnv('TOWER_TEAM_WORKSPACES_ENABLED', '1');
  team.resolve.mockResolvedValue(null);
  await expect(requireCurrentAgentExecutionAccess(input)).resolves.toMatchObject({ projectMember: true });
});
