import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/188_project_workstation_change_intents.sql'), 'utf8');

describe('Project Workstation change intents migration', () => {
  it('stores stale-safe binding and target snapshots without secret material', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS project_workstation_change_intents');
    expect(sql).toContain('expected_binding JSONB NULL');
    expect(sql).toContain('target_snapshot JSONB NOT NULL');
    expect(sql).toContain('proposal_hash TEXT NOT NULL');
    expect(sql).toContain('smoke_receipt_hash TEXT NULL');
    expect(sql).toContain('smoke_verified_at TIMESTAMPTZ NULL');
    expect(sql).toContain("status IN ('previewed','succeeded','failed')");
    expect(sql).not.toMatch(/token|password|credential_value|secret_value/i);
  });
});
