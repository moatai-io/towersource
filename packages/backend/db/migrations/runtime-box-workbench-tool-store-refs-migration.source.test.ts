import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/152_runtime_box_workbench_tool_store_refs.sql'), 'utf8');

describe('Workbench managed store migration', () => {
  it('adds an explicit storage identity without rewriting legacy project-prefix rows', () => {
    expect(migration).toContain("DEFAULT 'project-prefix'");
    expect(migration).toContain("'tower-managed-v1'");
    expect(migration).toContain('store_ref TEXT');
    expect(migration).toContain('store_manifest_hash TEXT');
    expect(migration).not.toContain('DROP TABLE');
    expect(migration).not.toContain('DELETE FROM');
  });

  it('records per-Box mounted revision observations separately from active pointer state', () => {
    expect(migration).toContain('runtime_box_workbench_tool_projections');
    expect(migration).toContain('box_id BIGINT PRIMARY KEY');
    expect(migration).toContain("status IN ('mounted', 'stale', 'unmounted', 'recovery_required')");
    expect(migration).toContain('FOREIGN KEY(project_id, revision)');
  });
});
