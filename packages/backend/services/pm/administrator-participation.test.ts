import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), txQuery: vi.fn(), transaction: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ query: mocks.query, transaction: mocks.transaction }));
import { changeAdministratorParticipation, hasAdministratorParticipation, listAdministratorParticipants } from './administrator-participation.js';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async fn => fn({ query: mocks.txQuery }));
});
describe('historical participation is not content authority', () => {
  it.each(['project', 'channel'] as const)('rejects %s self-entry before any target or audit writes', async scope => {
    await expect(changeAdministratorParticipation({ scope, targetId: 'target', userId: 7, join: true })).rejects.toMatchObject({ status: 403 });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.txQuery).not.toHaveBeenCalled();
  });
  it.each(['project', 'channel'] as const)('never grants %s content access from a legacy participation', async scope => {
    expect(await hasAdministratorParticipation(scope, 'target', 7)).toBe(false);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it.each(['admin', 'operator', 'member'])('allows %s to leave its own historical record with atomic audit', async role => {
    mocks.txQuery.mockResolvedValueOnce({ rows: [{ role, disabled: 0 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'target' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'participation', left_at: null }] })
      .mockResolvedValue({ rows: [] });
    expect(await changeAdministratorParticipation({ scope: 'project', targetId: 'target', userId: 7, join: false }))
      .toMatchObject({ changed: true, joined: false, participationId: 'participation' });
    expect(mocks.txQuery.mock.calls.map(call => call[0]).join('\n')).not.toContain('INSERT INTO administrator_participations');
    expect(mocks.txQuery).toHaveBeenCalledWith(expect.stringContaining('UPDATE administrator_participations SET left_at = now()'), ['participation']);
    expect(mocks.txQuery).toHaveBeenLastCalledWith(expect.stringContaining('INSERT INTO administrator_participation_events'),
      [expect.any(String), 'participation', 7, 'target', 'left']);
  });
  it('makes repeated leave a no-op', async () => {
    mocks.txQuery.mockResolvedValueOnce({ rows: [{ role: 'operator', disabled: 0 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'target' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'participation', left_at: 'already-left' }] });
    expect(await changeAdministratorParticipation({ scope: 'channel', targetId: 'target', userId: 7, join: false }))
      .toMatchObject({ changed: false, joined: false });
    expect(mocks.txQuery).toHaveBeenCalledTimes(3);
  });
  it('keeps operational participant history separate from access', async () => {
    mocks.query.mockResolvedValue([]);
    await listAdministratorParticipants('project', 'target');
    expect(mocks.query.mock.calls[0][0]).toContain("u.role = 'operator'");
    expect(mocks.query.mock.calls[0][0]).toContain('u.disabled = 0');
  });
  it('rejects disabled accounts before any writes', async () => {
    mocks.txQuery.mockResolvedValue({ rows: [{ role: 'operator', disabled: 1 }] });
    await expect(changeAdministratorParticipation({ scope: 'project', targetId: 'target', userId: 7, join: false })).rejects.toMatchObject({ status: 403 });
    expect(mocks.txQuery).toHaveBeenCalledTimes(1);
  });
});
