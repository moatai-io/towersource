import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('./176_worker_service_runner.sql', import.meta.url), 'utf8');
const indexes = readFileSync(new URL('./180_worker_service_runner_indexes.sql', import.meta.url), 'utf8');

describe('worker service runner migration', () => {
  it('lets runtime_box_services represent either Runtime Box or remote Worker services without storing transport secrets', () => {
    expect(migration).toContain("runner_kind TEXT NOT NULL DEFAULT 'runtime-box'");
    expect(migration).toContain('worker_id TEXT');
    expect(migration).toContain('ALTER COLUMN box_id DROP NOT NULL');
    expect(migration).toContain("runner_kind = 'remote-worker' AND box_id IS NULL AND worker_id IS NOT NULL");
    expect(migration).not.toContain('CREATE INDEX');
    expect(indexes).toContain('runtime_box_services_worker_status_idx');
    expect(indexes).toContain('runtime_box_services_worker_name_unique');
    expect(`${migration}\n${indexes}`).not.toMatch(/token|secret|credential|password/i);
  });
});
