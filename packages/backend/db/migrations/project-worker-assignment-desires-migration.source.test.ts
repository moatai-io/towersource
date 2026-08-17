import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/185_project_worker_assignment_desires.sql'), 'utf8');
const recovery = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/186_project_worker_assignment_recovery_required.sql'), 'utf8');

describe('Project Worker assignment desired-state migration', () => {
  it('keeps pending preparation separate from active deployment binding', () => {
    expect(sql).toContain('project_worker_assignment_desires');
    expect(sql).toContain("status IN ('pending','preparing','active','failed','cancelled')");
    expect(sql).toContain('desired_worker_id');
    expect(sql).toContain('lease_owner');
    expect(sql).toContain('lease_expires_at');
    expect(sql).not.toContain('INSERT INTO project_compute_deployment_bindings');
    expect(sql).not.toContain('UPDATE project_compute_deployment_bindings');
    expect(recovery).toContain("'recovery_required'");
    expect(recovery).toContain('DROP CONSTRAINT IF EXISTS project_worker_assignment_desires_status_check');
  });
});
