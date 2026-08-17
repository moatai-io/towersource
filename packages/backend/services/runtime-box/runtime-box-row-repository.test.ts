import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => mocks);

import { queryBoxes, queryBoxOne, queryServiceOne, queryServices } from './runtime-box-row-repository.js';

const row = (id: unknown, createdBy: unknown) => ({
  id, project_id: 'p', status: 'stopped', runtime_profile: 'node22-python313', container_id: null,
  project_root: '/workspace/projects/p', memory_mb: 3072, cpu_limit: '1', pids_limit: 256,
  disk_quota_mb: 10240, idle_stop_minutes: 20, last_active_at: null, started_at: null,
  stopped_at: null, last_error: null, error_at: null, created_at: 'now', created_by: createdBy,
  updated_at: 'now', secure_mode: null, network_policy: null,
});

const serviceRow = (id: unknown, boxId: unknown) => ({
  id, box_id: boxId, project_id: 'p', name: 'dev', display_name: null, command: 'npm run dev',
  cwd: '/workspace', internal_port: 3000, host_port: null, external_url: null, preview_token: null,
  status: 'stopped', visibility: 'private', process_pid: null, log_path: null, pinned: false,
  purpose: null, owner_user_id: 1, ttl_hours: 2, review_after: null, started_at: null,
  stopped_at: null, expires_at: null, last_active_at: null, created_at: 'now', created_by: 1,
  last_error: null,
});

describe('Runtime Box row repository boundary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('normalizes query-one BIGINT strings immediately', async () => {
    mocks.queryOne.mockResolvedValue(row('62', '7'));
    await expect(queryBoxOne('SELECT box', ['p'])).resolves.toMatchObject({ id: 62, created_by: 7 });
    expect(mocks.queryOne).toHaveBeenCalledWith('SELECT box', ['p']);
  });

  it('normalizes list rows and preserves missing one semantics', async () => {
    mocks.query.mockResolvedValue([row('62', null), row('75', '1')]);
    await expect(queryBoxes('SELECT boxes')).resolves.toMatchObject([
      { id: 62, created_by: null }, { id: 75, created_by: 1 },
    ]);
    mocks.queryOne.mockResolvedValue(undefined);
    await expect(queryBoxOne('SELECT missing')).resolves.toBeUndefined();
  });

  it('normalizes Service query-one and list BIGINT strings immediately', async () => {
    mocks.queryOne.mockResolvedValue(serviceRow('88', '75'));
    await expect(queryServiceOne('SELECT service')).resolves.toMatchObject({ id: 88, box_id: 75 });
    mocks.query.mockResolvedValue([serviceRow('88', '75')]);
    await expect(queryServices('SELECT services')).resolves.toMatchObject([{ id: 88, box_id: 75 }]);
  });

  it('fails before returning malformed persisted identity', async () => {
    mocks.queryOne.mockResolvedValue(row('62.5', '7'));
    await expect(queryBoxOne('SELECT invalid')).rejects.toThrow(/Invalid Runtime Box id/);
  });
});
