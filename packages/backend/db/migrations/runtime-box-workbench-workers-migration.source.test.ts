import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('./170_runtime_box_workbench_workers.sql', import.meta.url), 'utf8');

describe('Remote Workbench Worker registry migration', () => {
  it('persists only non-secret scheduling, liveness, scope, and capacity state', () => {
    expect(migration).toContain('runtime_box_workbench_workers');
    expect(migration).toContain('worker_id TEXT PRIMARY KEY');
    expect(migration).toContain('capabilities TEXT[]');
    expect(migration).toContain('project_ids TEXT[]');
    expect(migration).toContain('heartbeat_at TIMESTAMPTZ');
    expect(migration).toContain('draining BOOLEAN');
    expect(migration).toContain('active_runs <= max_runs');
    expect(migration).toContain('USING GIN (project_ids)');
    expect(migration).not.toMatch(/token|secret|credential/i);
  });
});
