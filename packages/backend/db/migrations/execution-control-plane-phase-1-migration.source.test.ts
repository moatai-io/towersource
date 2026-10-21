import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(
  path.join(process.cwd(), 'packages/backend/db/migrations/221_execution_control_plane_phase_1.sql'),
  'utf8',
);
const indexSql = fs.readFileSync(
  path.join(process.cwd(), 'packages/backend/db/migrations/222_execution_control_plane_phase_1_indexes.sql'),
  'utf8',
);

describe('Execution Control Plane Phase 1 migration', () => {
  it('creates an additive lifecycle ledger with explicit scope and terminal states', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS executions');
    expect(sql).toContain("source_kind IN ('automation','manual','agent','webhook','system')");
    expect(sql).toContain("scope_kind IN ('project','system','personal')");
    expect(sql).toContain("'succeeded','failed','cancelled','timed_out','uncertain'");
    expect(sql).toContain("scope_kind = 'project' AND project_id IS NOT NULL");
    expect(sql).toContain("scope_kind IN ('system','personal') AND project_id IS NULL");
    expect(indexSql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_idempotency');
  });

  it('stores transition history separately from Process Map projections', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS execution_events');
    expect(sql).toContain('execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE');
    expect(sql).toContain("payload JSONB NOT NULL DEFAULT '{}'::jsonb");
  });

  it('links existing projections without rewriting historical rows', () => {
    expect(sql).toContain('ALTER TABLE automation_runs');
    expect(sql).toContain('ALTER TABLE process_events');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS execution_id TEXT REFERENCES executions(id) ON DELETE SET NULL');
    expect(sql).not.toMatch(/UPDATE\s+(automation_runs|process_events)/i);
    expect(sql).not.toMatch(/side_effect_executions|agent_runs/i);
  });

  it('builds indexes in a separate migration after ALTER TABLE locks are released', () => {
    expect(sql).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX/i);
    expect(indexSql).not.toMatch(/ALTER\s+TABLE/i);
    expect(indexSql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_execution');
    expect(indexSql).toContain('CREATE INDEX IF NOT EXISTS idx_process_events_execution_time');
  });
});
