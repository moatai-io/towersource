import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/162_runtime_box_workbench_jobs.sql'), 'utf8');

describe('runtime_box_workbench_jobs migration', () => {
  it('defines durable lifecycle, attribution, revision, output, and cancellation evidence', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS runtime_box_workbench_jobs');
    for (const field of ['project_id', 'requested_by_user_id', 'requested_by_session_id', 'provider_kind', 'status', 'workbench_revision', 'stdout_text', 'stderr_text', 'cancel_requested_at']) {
      expect(sql).toContain(field);
    }
    for (const status of ['queued', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled']) {
      expect(sql).toContain(`'${status}'`);
    }
    expect(sql).toContain("provider_kind IN ('local-runtime', 'remote-worker')");
    expect(sql).toContain("WHERE status IN ('queued', 'running', 'cancel_requested')");
  });
});
