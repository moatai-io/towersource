import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('./171_runtime_box_workbench_worker_identities.sql', import.meta.url), 'utf8');

describe('Workbench Worker identity audit migration', () => {
  it('stores scope and revocation handles without raw JWT material', () => {
    expect(migration).toContain('runtime_box_workbench_worker_identities');
    expect(migration).toContain('jti TEXT PRIMARY KEY');
    expect(migration).toContain('project_ids TEXT[]');
    expect(migration).toContain('capabilities TEXT[]');
    expect(migration).toContain('revoked_at TIMESTAMPTZ');
    expect(migration).toContain('replaced_by_jti');
    expect(migration).not.toMatch(/token_value|raw_token|jwt_value|value_encrypted/i);
  });
});
