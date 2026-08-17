import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execute, queryOne } from '../../db/pg-repo.js';
import { deleteProjectComputeSettings, getProjectComputeSettings, upsertProjectComputeSettings } from './workbench-project-compute-settings.js';

vi.mock('../../db/pg-repo.js', () => ({ queryOne: vi.fn(), execute: vi.fn() }));

const row = {
  project_id: '11111111-1111-4111-8111-111111111111',
  default_worker_id: 'iwinv-01',
  workstation_mode: true,
  authority_mode: 'operator-plane',
  updated_by_user_id: 7,
  created_at: '2026-08-12T10:00:00.000Z',
  updated_at: '2026-08-12T10:01:00.000Z',
};

beforeEach(() => vi.clearAllMocks());

describe('Project compute settings repository', () => {
  it('reads missing settings as undefined', async () => {
    vi.mocked(queryOne).mockResolvedValue(undefined);
    await expect(getProjectComputeSettings(row.project_id)).resolves.toBeUndefined();
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('project_compute_settings'), [row.project_id]);
  });

  it('normalizes non-secret Project Worker preferences', async () => {
    vi.mocked(queryOne).mockResolvedValue(row);
    await expect(getProjectComputeSettings(row.project_id)).resolves.toEqual({
      projectId: row.project_id,
      defaultWorkerId: 'iwinv-01',
      workstationMode: true,
      authorityMode: 'operator-plane',
      updatedByUserId: 7,
      createdAt: '2026-08-12T10:00:00.000Z',
      updatedAt: '2026-08-12T10:01:00.000Z',
    });
  });

  it('upserts default Worker and workstation mode without secret material', async () => {
    vi.mocked(queryOne).mockResolvedValue(row);
    await expect(upsertProjectComputeSettings({
      projectId: row.project_id,
      defaultWorkerId: ' iwinv-01 ',
      workstationMode: true,
      authorityMode: 'operator-plane',
      updatedByUserId: 7,
    })).resolves.toMatchObject({ defaultWorkerId: 'iwinv-01', workstationMode: true, authorityMode: 'operator-plane' });
    const [sql, params] = vi.mocked(queryOne).mock.calls[0];
    expect(sql).toContain('ON CONFLICT(project_id) DO UPDATE');
    expect(sql).not.toMatch(/token|secret|credential|password/i);
    expect(params).toEqual([row.project_id, 'iwinv-01', true, 'operator-plane', 7]);
  });

  it('deletes settings for legacy fallback', async () => {
    vi.mocked(execute).mockResolvedValue({ changes: 1 });
    await expect(deleteProjectComputeSettings(row.project_id)).resolves.toBe(true);
  });
});
