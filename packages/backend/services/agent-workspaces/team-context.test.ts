import { beforeEach, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ queryOne: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => db);
import { resolveTeamAgentContext } from './team-context.js';
const input = { userId: 1, agentProjectId: 'agent-a' };
const facts = { user_role: 'member', user_active: true, agent_active: true, team_id: 'sales', team_member: true, workspaces: [] };
beforeEach(() => { vi.resetAllMocks(); db.queryOne.mockResolvedValue(facts); });

it('returns null only for an existing active eligible teamless Agent', async () => {
  db.queryOne.mockResolvedValue({ ...facts, team_id: null });
  expect(await resolveTeamAgentContext(input)).toBeNull();
});
it('permits a team member without manufacturing Project membership', async () => {
  expect(await resolveTeamAgentContext(input)).toEqual({ agentProjectId: 'agent-a', teamId: 'sales', userId: 1 });
});
it.each([
  null, { ...facts, user_active: false }, { ...facts, agent_active: false },
  { ...facts, team_member: false }, { ...facts, user_role: 'viewer' },
  { ...facts, user_role: 'guest' }, { ...facts, user_role: 'admin', team_member: false },
])('never converts denied team facts to legacy fallback: %j', async row => {
  db.queryOne.mockResolvedValue(row);
  await expect(resolveTeamAgentContext(input)).rejects.toThrow('ACCESS_DENIED');
});
it.each([
  { ...facts, team_id: null, user_active: false },
  { ...facts, team_id: null, agent_active: false },
])('rejects invalid current facts even for teamless Agents: %j', async row => {
  db.queryOne.mockResolvedValue(row);
  await expect(resolveTeamAgentContext(input)).rejects.toThrow('ACCESS_DENIED');
});
it.each(['viewer', 'guest'])('returns teamless null for %s without granting execution or Session audience', async role => {
  db.queryOne.mockResolvedValue({ ...facts, team_id: null, user_role: role });
  expect(await resolveTeamAgentContext(input)).toBeNull();
});
it('leaves legacy profile eligibility to the caller rather than requiring a team profile', async () => {
  db.queryOne.mockResolvedValue({ ...facts, team_id: null });
  expect(await resolveTeamAgentContext(input)).toBeNull();
  const [sql] = db.queryOne.mock.calls[0];
  expect(sql).toMatch(/WHEN tp.team_id IS NULL THEN p.archived=0 AND p.lifecycle_status='active'/);
});
it('rejects missing requester/Agent before SQL', async () => {
  await expect(resolveTeamAgentContext({ ...input, userId: 0 })).rejects.toThrow('CONTEXT_REQUIRED');
  expect(db.queryOne).not.toHaveBeenCalled();
});
it('propagates DB failure instead of treating it as a teamless Agent', async () => {
  db.queryOne.mockRejectedValue(new Error('db unavailable'));
  await expect(resolveTeamAgentContext(input)).rejects.toThrow('db unavailable');
});
it('uses repository current-state checks without loading inventory or applying its cap', async () => {
  await resolveTeamAgentContext(input);
  expect(db.queryOne).toHaveBeenCalledTimes(1);
  const [sql, params] = db.queryOne.mock.calls[0];
  expect(params).toEqual(['agent-a', 1]);
  expect(sql).toMatch(/approval_status='active'/);
  expect(sql).toMatch(/lifecycle_status='active'/);
  expect(sql).toMatch(/pap.status IN \('active','ready'\)/);
  expect(sql).not.toMatch(/agent_workspaces|LIMIT 257|project_members|app_settings|sessions/i);
});
