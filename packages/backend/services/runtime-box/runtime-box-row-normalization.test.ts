import { describe, expect, it } from 'vitest';
import {
  normalizeBoxRow,
  normalizeBoxRows,
  normalizeNullableRuntimeBoxUserId,
  normalizeRuntimeBoxId,
  normalizeServiceRow,
  normalizeServiceRows,
  type RawBoxRow,
  type RawServiceRow,
} from './runtime-box-row-normalization.js';

const rawBox = (overrides: Partial<RawBoxRow> = {}): RawBoxRow => ({
  id: '62', project_id: 'project-1', status: 'running', runtime_profile: 'node22-python313',
  container_id: 'container-1', project_root: '/workspace/projects/project-1', memory_mb: 3072,
  cpu_limit: '1', pids_limit: 256, disk_quota_mb: 10240, idle_stop_minutes: 20,
  last_active_at: null, started_at: null, stopped_at: null, last_error: null, error_at: null,
  created_at: '2026-08-02T00:00:00.000Z', created_by: '7', updated_at: '2026-08-02T00:00:00.000Z',
  secure_mode: null, network_policy: null, ...overrides,
});

describe('Runtime Box persisted BIGINT row normalization', () => {
  it('accepts positive safe integers from PostgreSQL and existing numeric callers', () => {
    expect(normalizeRuntimeBoxId('62')).toBe(62);
    expect(normalizeRuntimeBoxId(62)).toBe(62);
    expect(normalizeRuntimeBoxId(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(normalizeNullableRuntimeBoxUserId(null)).toBeNull();
  });

  it('normalizes Box BIGINT fields without mutating the raw query row', () => {
    const raw = rawBox();
    const normalized = normalizeBoxRow(raw);
    expect(normalized).toMatchObject({ id: 62, created_by: 7, project_id: 'project-1' });
    expect(raw).toMatchObject({ id: '62', created_by: '7' });
    expect(normalizeBoxRows([raw, rawBox({ id: 63, created_by: null })])).toMatchObject([
      { id: 62, created_by: 7 }, { id: 63, created_by: null },
    ]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '', '0', '-1', '1.5', 'abc', null, undefined])(
    'rejects invalid persisted identity %s',
    value => expect(() => normalizeRuntimeBoxId(value)).toThrow(/Invalid Runtime Box id/),
  );

  it('normalizes Service BIGINT identity fields without mutating the raw row', () => {
    const raw: RawServiceRow = {
      id: '88', box_id: '75', project_id: 'project-1', name: 'dev', display_name: null,
      command: 'npm run dev', cwd: '/workspace', internal_port: 3000, host_port: null,
      external_url: null, preview_token: null, status: 'stopped', visibility: 'private',
      process_pid: null, log_path: null, pinned: false, purpose: null, owner_user_id: 1,
      ttl_hours: 2, review_after: null, started_at: null, stopped_at: null, expires_at: null,
      last_active_at: null, created_at: 'now', created_by: 1, last_error: null,
    };
    expect(normalizeServiceRow(raw)).toMatchObject({ id: 88, box_id: 75 });
    expect(raw).toMatchObject({ id: '88', box_id: '75' });
    expect(normalizeServiceRows([raw])).toMatchObject([{ id: 88, box_id: 75 }]);
    expect(() => normalizeServiceRow({ ...raw, id: '88.5' })).toThrow(/Invalid persisted Runtime Box Service id/);
  });

  it('rejects malformed persisted Box user identity', () => {
    expect(() => normalizeBoxRow(rawBox({ created_by: '7.5' }))).toThrow(/Invalid persisted Runtime Box user id/);
  });
});
