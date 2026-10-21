import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
const pg = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), withClient: vi.fn(), transaction: vi.fn() }));
const membership = vi.hoisted(() => ({ getAccessibleProjectIds: vi.fn(), addProjectMember: vi.fn(), autoSeedProjectMembers: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => pg);
vi.mock('../../config.js', () => ({ config: { workspaceRoot: '/tmp/tower-invitation-test/workspace', agentFirstEnabled: false } }));
vi.mock('./project-membership-manager.js', () => membership);
import { getProjects, searchAccessibleProjects } from './project-manager.js';
beforeEach(() => { vi.resetAllMocks(); membership.getAccessibleProjectIds.mockResolvedValue([]); pg.query.mockResolvedValue([]); });
describe('role-independent project list and search', () => {
  it.each(['admin', 'operator', 'member', 'viewer'])('does not discover noninvited projects as %s', async role => {
    expect(await getProjects(7, role)).toEqual([]);
    expect(await searchAccessibleProjects(7, role, 'secret')).toEqual([]);
    expect(pg.query).not.toHaveBeenCalled();
  });
  it('returns only the explicit member set for an administrator', async () => {
    membership.getAccessibleProjectIds.mockResolvedValue(['invited']);
    pg.query.mockResolvedValueOnce([{ id: 'invited', name: 'Invited', root_path: '/invited' }, { id: 'secret', name: 'Secret' }]).mockResolvedValueOnce([]);
    expect((await getProjects(7, 'admin')).map(p => p.id)).toEqual(['invited']);
  });
  it('search scopes SQL to the member set and never expands through creator metadata', async () => {
    membership.getAccessibleProjectIds.mockResolvedValue(['invited']);
    await searchAccessibleProjects(7, 'operator', 'secret');
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain('p.id = ANY($2::text[])');
    expect(sql).not.toContain('p.user_id =');
    expect(sql).not.toContain('::boolean');
    expect(params).toEqual(['%secret%', ['invited'], 50]);
  });
  it('fails closed without authenticated identity even when role is admin', async () => {
    expect(await getProjects(undefined, 'admin')).toEqual([]);
    expect(pg.query).not.toHaveBeenCalled();
    expect(membership.getAccessibleProjectIds).not.toHaveBeenCalled();
  });
  it('creates ordinary projects unlisted and only adds the creator, not admin/operator accounts', () => {
    const source = fs.readFileSync(new URL('./project-manager.ts', import.meta.url), 'utf8');
    const create = source.slice(source.indexOf('export async function createProject'), source.indexOf('// ── Default projects'));
    expect(create).toContain("creation_command_id, directory_visibility) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'unlisted')");
    expect(create).toContain("await addProjectMember(id, userId, 'owner')");
    expect(create).not.toContain('await autoSeedProjectMembers(');
    expect(create).not.toContain("role IN ('admin', 'operator')");
  });
});
