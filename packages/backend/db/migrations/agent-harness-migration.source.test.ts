import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const migration = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/120_agent_harness_registry.sql'), 'utf8');

describe('Agent Harness registry migration', () => {
  it('adds versioned Harness, runtime profile, Project binding, and Session snapshot tables', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS harnesses');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS harness_versions');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS harness_runtime_profiles');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS project_agent_harness_bindings');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS session_runtime_snapshots');
  });

  it('binds a runtime profile to the same Harness version and pins snapshots per Session', () => {
    expect(migration).toContain('FOREIGN KEY (runtime_profile_id, harness_id, harness_version)');
    expect(migration).toContain('session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE');
    expect(migration).toContain('snapshot_hash TEXT NOT NULL');
  });

  it('seeds tower-default and quick-web-research without backfilling every Project', () => {
    expect(migration).toContain("('tower-default','Tower Default'");
    expect(migration).toContain("('quick-web-research','Quick Web Research'");
    expect(migration).not.toMatch(/INSERT INTO project_agent_harness_bindings/i);
  });
});
