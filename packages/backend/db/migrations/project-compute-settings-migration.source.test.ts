import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('./175_project_compute_settings.sql', import.meta.url), 'utf8');

describe('project compute settings migration', () => {
  it('stores only non-secret Project Worker preferences', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS project_compute_settings');
    expect(migration).toContain('project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE');
    expect(migration).toContain('default_worker_id TEXT NULL REFERENCES runtime_box_workbench_workers(worker_id) ON DELETE SET NULL');
    expect(migration).toContain('workstation_mode BOOLEAN NOT NULL DEFAULT FALSE');
    expect(migration).not.toMatch(/token|secret|credential|password/i);
  });
});
