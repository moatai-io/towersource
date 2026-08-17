import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/128_ai_service_activation_evaluations.sql'), 'utf8');

describe('AI Service activation evaluation migration', () => {
  it('records immutable runtime-contract fingerprints for activation freshness', () => {
    for (const field of ['deployment_snapshot_hash', 'harness_id', 'harness_version', 'runtime_profile_id', 'runtime_profile_version', 'effective_manifest_hash', 'tool_set_hash']) {
      expect(migration).toContain(field);
    }
    expect(migration).toContain("status IN ('passed','failed')");
    expect(migration).toContain('idx_ai_service_runtime_evaluations_latest');
  });
});
