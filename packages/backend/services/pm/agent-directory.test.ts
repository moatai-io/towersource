import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn(), clientQuery: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ query: m.query, queryOne: m.queryOne, transaction: (fn: any) => fn({ query: m.clientQuery }) }));
import { agentDirectoryVisibility, listAgentDirectory, listPreviousAgentParticipation } from './agent-directory.js';

beforeEach(() => { vi.resetAllMocks(); m.queryOne.mockResolvedValue({ role: 'member', disabled: 0 }); m.query.mockResolvedValue([]); });
describe('invitation-only agent discovery', () => {
  it.each(['member', 'viewer', 'operator', 'admin'])('returns only invited metadata for %s, even with historical participation', async role => {
    m.queryOne.mockResolvedValue({ role, disabled: 0 });
    m.query.mockResolvedValue([
      { id: 'invited', name: 'Research', short_role: 'Research briefs', contact_name: 'Contact', is_member: true,
        root_path: '/protected', instruction: 'private instruction', sessions: ['secret title'] },
      { id: 'not-invited', name: 'Private agent', is_member: false, participating: true },
    ]);
    expect(await listAgentDirectory(7)).toEqual([{ projectId: 'invited', name: 'Research', shortRole: 'Research briefs', contactName: 'Contact', access: 'available' }]);
    const sql = m.query.mock.calls[0][0];
    expect(sql).toContain('invited.project_id = p.id AND invited.user_id = $1');
    expect(sql).not.toContain('administrator_participations');
    expect(sql).not.toContain("directory_visibility = 'listed'");
    expect(sql).not.toContain('p.user_id = $1');
  });
  it.each([{ role: 'guest', disabled: 0 }, { role: 'admin', disabled: 1 }, null])('denies invalid current account %j', async actor => {
    m.queryOne.mockResolvedValue(actor);
    await expect(listAgentDirectory(7)).rejects.toMatchObject({ status: 403 });
    expect(m.query).not.toHaveBeenCalled();
  });
  it('excludes archived, inactive and system projects', async () => {
    await listAgentDirectory(7);
    const sql = m.query.mock.calls[0][0];
    expect(sql).toContain("COALESCE(p.lifecycle_status, 'active') = 'active'");
    expect(sql).toContain('COALESCE(p.archived, 0) = 0');
    expect(sql).toContain('p.system_key IS NULL');
  });
});
describe('directory visibility owner settings', () => {
  it.each(['confidential', 'unlisted', 'listed'] as const)('an invited owner may save %s without exposing metadata to nonmembers', async visibility => {
    m.clientQuery.mockResolvedValueOnce({ rows: [{ role: 'member', disabled: 0 }] })
      .mockResolvedValueOnce({ rows: [{ directory_visibility: 'unlisted', is_owner: true }] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await agentDirectoryVisibility(7, 'agent', visibility)).toEqual({ projectId: 'agent', visibility });
    expect(m.clientQuery).toHaveBeenLastCalledWith('UPDATE projects SET directory_visibility = $2 WHERE id = $1', ['agent', visibility]);
  });
  it.each(['admin', 'operator', 'member'])('denies nonowner %s even for visibility reads', async role => {
    m.clientQuery.mockResolvedValueOnce({ rows: [{ role, disabled: 0 }] })
      .mockResolvedValueOnce({ rows: [{ directory_visibility: 'listed', is_owner: false }] });
    await expect(agentDirectoryVisibility(7, 'agent')).rejects.toMatchObject({ status: 403 });
    expect(m.clientQuery).toHaveBeenCalledTimes(2);
  });
  it('defaults a missing legacy visibility to unlisted', async () => {
    m.clientQuery.mockResolvedValueOnce({ rows: [{ role: 'member', disabled: 0 }] })
      .mockResolvedValueOnce({ rows: [{ directory_visibility: null, is_owner: true }] });
    expect(await agentDirectoryVisibility(7, 'agent')).toEqual({ projectId: 'agent', visibility: 'unlisted' });
  });
  it('rejects viewer or disabled account writes before looking up the agent', async () => {
    m.clientQuery.mockResolvedValue({ rows: [{ role: 'viewer', disabled: 0 }] });
    await expect(agentDirectoryVisibility(7, 'agent', 'listed')).rejects.toMatchObject({ status: 403 });
    expect(m.clientQuery).toHaveBeenCalledTimes(1);
  });
  it('rejects missing, archived or system agents', async () => {
    m.clientQuery.mockResolvedValueOnce({ rows: [{ role: 'operator', disabled: 0 }] }).mockResolvedValueOnce({ rows: [] });
    await expect(agentDirectoryVisibility(7, 'missing', 'listed')).rejects.toMatchObject({ status: 404 });
  });
});

it('limits historical discovery to own sessions without current membership and returns names only', async () => {
  m.queryOne.mockResolvedValue({ role: 'member', disabled: 0 });
  m.query.mockResolvedValue([{ id: 'old', name: 'Old' }]);
  expect(await listPreviousAgentParticipation(7)).toEqual([{ id: 'old', name: 'Old' }]);
  const sql = m.query.mock.calls[0][0];
  expect(sql).toContain('s.user_id = $1');
  expect(sql).toContain('NOT EXISTS (SELECT 1 FROM project_members');
  expect(sql).toContain('p.deleted_at IS NULL');
  expect(sql).not.toMatch(/s\.(name|content)|cwd|instruction/);
});
it('blocks disabled accounts from historical discovery', async () => {
  m.queryOne.mockResolvedValue({ role: 'admin', disabled: 1 });
  await expect(listPreviousAgentParticipation(7)).rejects.toMatchObject({ status: 403 });
  expect(m.query).not.toHaveBeenCalled();
});
