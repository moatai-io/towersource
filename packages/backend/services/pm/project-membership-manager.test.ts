import { beforeEach, describe, expect, it, vi } from 'vitest';
const pg = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => pg);
import { autoSeedProjectMembers, autoSeedUserMemberships, getAccessibleProjectIds, isProjectMember } from './project-membership-manager.js';
beforeEach(() => { vi.resetAllMocks(); pg.query.mockResolvedValue([]); pg.execute.mockResolvedValue({ changes: 0 }); });
describe('invitation-only membership', () => {
  it.each(['admin', 'operator', 'member', 'viewer', 'guest'])('%s never gets a null all-projects filter', async role => {
    expect(await getAccessibleProjectIds(7, role)).toEqual([]);
    const sql = pg.query.mock.calls[0][0];
    expect(sql).toContain('JOIN project_members');
    expect(sql).toContain('u.disabled = 0');
    expect(sql).toContain("COALESCE(p.lifecycle_status, 'active') = 'active'");
    expect(sql).not.toContain('p.user_id');
  });
  it('retains explicit membership regardless of cached role', async () => {
    pg.query.mockResolvedValue([{ id: 'invited' }]);
    expect(await getAccessibleProjectIds(7, 'admin')).toEqual(['invited']);
  });
  it.each([0, -1, NaN, 1.5])('fails closed for invalid identity %s', async userId => {
    expect(await getAccessibleProjectIds(userId, 'admin')).toEqual([]);
    expect(pg.query).not.toHaveBeenCalled();
  });
  it('membership requires a current active staff account, not admin role or creator metadata', async () => {
    pg.queryOne.mockResolvedValue(null);
    expect(await isProjectMember('private', 7)).toBe(false);
    const sql = pg.queryOne.mock.calls[0][0];
    expect(sql).toContain('JOIN users');
    expect(sql).toContain('u.disabled = 0');
    expect(sql).not.toContain('p.user_id');
  });
});
describe('system-only automatic membership', () => {
  it('project seeding requires an explicitly public system key and system ownership', async () => {
    expect(await autoSeedProjectMembers('ordinary')).toBe(0);
    const sql = pg.execute.mock.calls[0][0];
    expect(sql).toContain("p.system_key IN ('general', 'introduction')");
    expect(sql).toContain('p.user_id IS NULL');
    expect(sql).toContain("COALESCE(p.lifecycle_status, 'active') = 'active'");
  });
  it.each(['admin', 'operator', 'member'])('new %s cannot be implicitly added to ordinary projects', async role => {
    expect(await autoSeedUserMemberships(7, role)).toBe(0);
    const sql = pg.execute.mock.calls[0][0];
    expect(sql).toContain("p.system_key IN ('general', 'introduction')");
    expect(sql).toContain('u.disabled = 0');
    expect(sql).toContain('p.user_id IS NULL');
  });
  it.each(['guest', 'viewer', 'unknown'])('does not autojoin %s', async role => {
    expect(await autoSeedUserMemberships(7, role)).toBe(0);
    expect(pg.execute).not.toHaveBeenCalled();
  });
});
