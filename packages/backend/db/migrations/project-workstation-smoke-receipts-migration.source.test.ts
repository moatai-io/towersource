import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/189_project_workstation_smoke_receipts.sql'), 'utf8');

describe('Project Workstation smoke receipt migration', () => {
  it('idempotently upgrades databases where migration 188 was already applied', () => {
    expect(sql).toContain('ALTER TABLE project_workstation_change_intents');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS smoke_receipt_hash TEXT NULL');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS smoke_verified_at TIMESTAMPTZ NULL');
    expect(sql).toContain('project_workstation_change_intents_smoke_receipt_hash_check');
    expect(sql).toContain("'^[0-9a-f]{64}$'");
  });
});
