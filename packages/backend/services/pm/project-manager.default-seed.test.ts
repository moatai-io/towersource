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

  it('does not use legacy Test Project lookup because it is no longer a default project', async () => {
    const { DEFAULT_PROJECTS } = await import('./project-manager.js');
    expect(DEFAULT_PROJECTS.map((project) => project.slug)).not.toContain('test-project');
  });
});
