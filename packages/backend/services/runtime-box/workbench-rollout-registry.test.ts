import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query, queryOne } from '../../db/pg-repo.js';
import { listWorkbenchRollouts, resolveWorkbenchRollout, setWorkbenchRollout } from './workbench-rollout-registry.js';

vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock('../../config.js', () => ({ config: { experimentalWorkbenchTools: { projectIds: ['legacy-project'] } } }));

beforeEach(() => vi.clearAllMocks());

describe('Workbench rollout registry', () => {
  it('lets explicit DB state override the legacy env fallback', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ status: 'disabled', cohort: 'rollback' } as any);
    await expect(resolveWorkbenchRollout('legacy-project')).resolves.toEqual({
      enabled: false, status: 'disabled', source: 'database', cohort: 'rollback',
    });
  });

  it('uses legacy env only when no explicit DB state exists', async () => {
    vi.mocked(queryOne).mockResolvedValue(undefined);
    await expect(resolveWorkbenchRollout('legacy-project')).resolves.toMatchObject({ enabled: true, source: 'legacy-env' });
    await expect(resolveWorkbenchRollout('other-project')).resolves.toMatchObject({ enabled: false, source: 'default' });
  });

  it('upserts an auditable status for an active Project', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce({ id: 'project-a' } as any)
      .mockResolvedValueOnce({ project_id: 'project-a', status: 'enabled' } as any);
    await expect(setWorkbenchRollout({
      projectId: 'project-a', status: 'enabled', cohort: 'cohort-1', reason: 'dogfood', actorUserId: 7,
    })).resolves.toMatchObject({ status: 'enabled' });
    expect(vi.mocked(queryOne).mock.calls[1][0]).toContain('ON CONFLICT(project_id) DO UPDATE');
  });

  it('lists explicit rows with Project names', async () => {
    vi.mocked(query).mockResolvedValue([{ project_id: 'p', project_name: 'P', status: 'observe' }] as any);
    await expect(listWorkbenchRollouts()).resolves.toHaveLength(1);
  });
});
