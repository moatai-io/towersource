import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const columnsSql = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/163_runtime_box_workbench_job_claims.sql'), 'utf8');
const indexesSql = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/164_runtime_box_workbench_job_claim_indexes.sql'), 'utf8');

describe('Workbench Job claim migrations', () => {
  it('splits runner lease columns from claim indexes while preserving all evidence', () => {
    for (const field of ['claim_token', 'runner_id', 'heartbeat_at', 'lease_expires_at', 'attempt']) expect(columnsSql).toContain(field);
    expect(columnsSql).not.toContain('CREATE UNIQUE INDEX');
    expect(indexesSql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_box_workbench_jobs_claim_token');
    expect(indexesSql).toContain("WHERE status IN ('running', 'cancel_requested')");
  });
});
