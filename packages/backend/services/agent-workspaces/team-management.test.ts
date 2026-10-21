import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ transaction: vi.fn(), query: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ transaction: db.transaction }));
import { applyTeamManagement, previewTeamManagement } from './team-management.js';

beforeEach(() => { vi.resetAllMocks(); db.transaction.mockImplementation(fn => fn({ query: db.query })); });

describe('internal team management boundary', () => {
  it.each([
    { actorUserId: 0, command: { kind: 'create', teamId: 't', name: 'Team' } },
    { actorUserId: 1, command: { kind: 'create', teamId: '', name: 'Team' } },
    { actorUserId: 1, command: { kind: 'create', teamId: 't', name: '' } },
    { actorUserId: 1, command: { kind: 'invite', teamId: 't', userId: 0 } },
    { actorUserId: 1, command: { kind: 'assign', teamId: 't', projectId: '' } },
    { actorUserId: 1, command: { kind: 'unknown', teamId: 't' } },
  ])('rejects invalid internal input without starting a transaction: %j', async input => {
    await expect(previewTeamManagement(input as any)).rejects.toThrow('TEAM_MANAGEMENT_INPUT_INVALID');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation before any database work', async () => {
    await expect(applyTeamManagement({ actorUserId: 1, preview: {} as any, confirmed: false }))
      .rejects.toThrow('TEAM_MANAGEMENT_CONFIRMATION_REQUIRED');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('maps an absent-row create unique conflict from a non-participating writer to a typed error', async () => {
    const command = { kind: 'create', teamId: 't', name: 'Team' } as const;
    db.query.mockResolvedValueOnce({ rows: [{ id: 1, role: 'admin', disabled: 0, approval_status: 'active' }] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const preview = await previewTeamManagement({ actorUserId: 1, command });
    db.query.mockResolvedValueOnce({ rows: [{ id: 1, role: 'admin', disabled: 0, approval_status: 'active' }] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }));
    await expect(applyTeamManagement({ actorUserId: 1, preview, confirmed: true })).rejects.toThrow('TEAM_MANAGEMENT_TEAM_EXISTS');
  });

  it.each([
    undefined, { id: 1, role: 'operator', disabled: 0, approval_status: 'active' },
    { id: 1, role: 'admin', disabled: 1, approval_status: 'active' },
    { id: 1, role: 'admin', disabled: 0, approval_status: 'pending' },
  ])('rechecks current admin eligibility inside transaction: %j', async actor => {
    db.query.mockResolvedValue({ rows: actor ? [actor] : [] });
    await expect(previewTeamManagement({ actorUserId: 1, command: { kind: 'create', teamId: 't', name: 'Team' } }))
      .rejects.toThrow('TEAM_MANAGEMENT_ADMIN_REQUIRED');
    expect(db.query.mock.calls[0][0]).toMatch(/FOR SHARE/);
    expect(db.query.mock.calls.some(([sql]) => /INSERT|UPDATE|DELETE/.test(sql))).toBe(false);
  });
});
