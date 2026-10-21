import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';

vi.mock('../../db/pg-repo.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  withClient: vi.fn(),
}));

describe('default project startup seed lookup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.WORKSPACE_ROOT = '/tmp/tower-default-seed-test/workspace';
  });

  it('treats existing General suffix rows as the default instead of creating another General project', async () => {
    const pg = await import('../../db/pg-repo.js');
    vi.mocked(pg.queryOne).mockResolvedValueOnce({
      id: 'general-suffix',
      root_path: '/tmp/tower-default-seed-test/workspace/projects/general-4',
    });

    const { findExistingDefaultProject } = await import('./project-manager.js');
    const found = await findExistingDefaultProject({
      slug: 'general',
      name: 'General',
      color: '#3b82f6',
      description: 'Team-wide shared project for general work',
    });

    const canonicalRoot = path.join(process.env.WORKSPACE_ROOT!, 'projects', 'general');
    expect(found).toEqual({ id: 'general-suffix', root_path: `${canonicalRoot}-4` });
    expect(pg.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('OR root_path LIKE $2'),
      [canonicalRoot, `${canonicalRoot}-%`, 'General'],
    );
  });

  it('prepares Introduction only for Agent-first and does not autojoin read-only users', async () => {
    const { defaultProjectsForVm, DEFAULT_PROJECTS, getDefaultProjectIds } = await import('./project-manager.js');
    expect(defaultProjectsForVm(false).map(project => project.slug)).not.toContain('introduction');
    expect(defaultProjectsForVm(true).find(project => project.slug === 'introduction')).toMatchObject({
      autoSeedExistingMembers: 'all_non_viewer_guest',
    });
    expect(DEFAULT_PROJECTS.filter(project => project.slug === 'introduction')).toHaveLength(1);
    const pg = await import('../../db/pg-repo.js');
    vi.mocked(pg.queryOne).mockImplementation(async (_sql, params) =>
      params?.[0]?.toString().includes('introduction') ? { id: 'intro-id', root_path: '/tmp/intro' } : undefined);
    // The runtime flag can differ across deployments; role exclusion is always enforced.
    expect(await getDefaultProjectIds('viewer')).not.toContain('intro-id');
    expect(await getDefaultProjectIds('guest')).not.toContain('intro-id');
  });

  it('never autojoins ordinary or legacy defaults through their name or canonical path', async () => {
    const { getDefaultProjectIds } = await import('./project-manager.js');
    const pg = await import('../../db/pg-repo.js');
    vi.mocked(pg.queryOne).mockResolvedValue({ id: 'uninvited', root_path: '/private' });
    expect(await getDefaultProjectIds('admin')).toEqual([]);
    expect(await getDefaultProjectIds('operator')).toEqual([]);
    expect(await getDefaultProjectIds('member')).toEqual([]);
    // No explicit public system key in the current seed definitions: fail closed.
    expect(pg.queryOne).not.toHaveBeenCalled();
  });

  it('recognizes a pre-existing Introduction by canonical path without duplicating it', async () => {
    const pg = await import('../../db/pg-repo.js');
    vi.mocked(pg.queryOne).mockResolvedValueOnce({ id: 'existing-intro', root_path: '/tmp/tower-default-seed-test/workspace/projects/introduction' });
    const { findExistingDefaultProject } = await import('./project-manager.js');
    expect(await findExistingDefaultProject({ slug: 'introduction', name: 'Introduction', color: '#6d7fe8', description: 'Guide' }))
      .toMatchObject({ id: 'existing-intro' });
    expect(pg.queryOne).toHaveBeenCalledWith(expect.stringContaining('root_path = $1'),
      ['/tmp/tower-default-seed-test/workspace/projects/introduction']);
  });

  it('does not use legacy Test Project lookup because it is no longer a default project', async () => {
    const { DEFAULT_PROJECTS } = await import('./project-manager.js');
    expect(DEFAULT_PROJECTS.map((project) => project.slug)).not.toContain('test-project');
  });
});
