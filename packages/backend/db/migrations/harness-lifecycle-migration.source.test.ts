import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration=fs.readFileSync(path.join(process.cwd(),'packages/backend/db/migrations/123_harness_lifecycle.sql'),'utf8');
describe('Harness lifecycle migration',()=>{
  it('adds draft, validation, profile-version, and audit records',()=>{
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS harness_drafts');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS harness_validation_runs');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS harness_runtime_profile_versions');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS harness_audit_events');
  });
  it('makes published Harness content immutable and versioned bindings explicit',()=>{
    expect(migration).toContain('harness_published_version_immutable');
    expect(migration).toContain('runtime_profile_version INTEGER');
    expect(migration).toContain('project_agent_harness_bindings_runtime_profile_version_fkey');
  });
});
