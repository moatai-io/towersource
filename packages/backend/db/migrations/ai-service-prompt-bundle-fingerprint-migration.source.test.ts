import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/132_ai_service_prompt_bundle_fingerprint.sql'), 'utf8');

describe('AI Service Prompt Bundle fingerprint migration', () => {
  it('adds an additive nullable fingerprint so old evaluations fail closed until rerun', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS prompt_bundle_hash TEXT');
    expect(migration).toContain('idx_ai_service_runtime_evaluations_prompt_bundle');
    expect(migration).toContain('WHERE prompt_bundle_hash IS NOT NULL');
    expect(migration).not.toContain('prompt_bundle_hash TEXT NOT NULL');
  });
});
