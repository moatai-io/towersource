import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/193_workbench_worker_capacity_reservations.sql'), 'utf8');

describe('Workbench Worker capacity reservation migration', () => {
  it('creates an expiring per-execution ledger without storing commands or credentials', () => {
    expect(sql).toContain('runtime_box_workbench_worker_capacity_reservations');
    expect(sql).toContain('reservation_id UUID PRIMARY KEY');
    expect(sql).toContain('worker_id TEXT NOT NULL REFERENCES runtime_box_workbench_workers');
    expect(sql).toContain('project_id TEXT NOT NULL REFERENCES projects');
    expect(sql).toContain('session_id TEXT');
    expect(sql).toContain('expires_at TIMESTAMPTZ NOT NULL');
    expect(sql).toContain("state IN ('reserved','released','expired')");
    expect(sql).toContain("WHERE state = 'reserved'");
    expect(sql).not.toMatch(/command|credential|environment/i);
  });
});
