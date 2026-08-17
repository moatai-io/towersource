import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './127_agent_harness_p1_recovery.sql'), 'utf8');

describe('Agent Harness P1 recovery migration', () => {
  it('pins only Pi Sessions that predate the Harness registry rollout', () => {
    expect(source).toContain("version='120_agent_harness_registry'");
    expect(source).toContain("WHERE s.engine='pi'");
    expect(source).toContain('s.created_at < rollout.applied_at');
    expect(source).toContain('NOT EXISTS(SELECT 1 FROM session_runtime_snapshots');
  });

  it('uses the canonical tower-default snapshot and stable hash', () => {
    expect(source).toContain("'tower-default',1,'standard',1,'pi'");
    expect(source).toContain("'d6c9f8494b9a418889d98677d25425e3925a4346c5ce3bf1b7428af91fa288b6'");
    expect(source).toContain("'legacy-backfill'");
  });

  it('is replay-safe', () => {
    expect(source).toContain('DROP CONSTRAINT IF EXISTS project_agent_harness_current_revision_fkey');
    expect(source).toContain('ON CONFLICT(session_id) DO NOTHING');
  });
});
