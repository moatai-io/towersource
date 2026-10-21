import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ transaction: db.transaction }));
import { applyTeamManagementIntent, createTeamManagementIntent } from './team-management-intent.js';

beforeEach(() => vi.resetAllMocks());
describe('team approval intent input boundary', () => {
  it('requires explicit confirmation before any transaction', async () => {
    await expect(applyTeamManagementIntent({ actorUserId: 1, intentId: 'invalid', proposalHash: '', confirmed: false }))
      .rejects.toThrow('TEAM_MANAGEMENT_CONFIRMATION_REQUIRED');
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it.each([
    { actorUserId: 0, intentId: '6fc25445-de6e-4e73-ae32-97580aee12aa', proposalHash: 'a'.repeat(64) },
    { actorUserId: 1, intentId: 'invalid', proposalHash: 'a'.repeat(64) },
    { actorUserId: 1, intentId: '6fc25445-de6e-4e73-ae32-97580aee12aa', proposalHash: 'invalid' },
  ])('rejects invalid binding inputs: %j', async input => {
    await expect(applyTeamManagementIntent({ ...input, confirmed: true })).rejects.toThrow('TEAM_MANAGEMENT_INPUT_INVALID');
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it('validates issue input without constructing a raw client preview', async () => {
    await expect(createTeamManagementIntent({ actorUserId: 0, command: { kind: 'create', teamId: 't', name: 'Team' } }))
      .rejects.toThrow('TEAM_MANAGEMENT_INPUT_INVALID');
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
