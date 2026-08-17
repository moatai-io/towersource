import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('./168_runtime_box_workbench_rollouts.sql', import.meta.url), 'utf8');

describe('Workbench rollout migration', () => {
  it('stores restart-free Project overrides with audit and rollback states', () => {
    expect(migration).toContain('runtime_box_workbench_rollouts');
    expect(migration).toContain("CHECK (status IN ('enabled', 'disabled', 'observe'))");
    expect(migration).toContain('updated_by_user_id');
    expect(migration).toContain('enabled_at');
    expect(migration).toContain('disabled_at');
    expect(migration).toContain('ON DELETE CASCADE');
  });
});
