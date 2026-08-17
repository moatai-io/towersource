import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/150_runtime_box_workbench_tool_revisions.sql'), 'utf8');

describe('Workbench tool revision migration', () => {
  it('owns current state, immutable revisions, provenance, validation, and recovery health', () => {
    expect(sql).toContain('runtime_box_workbench_tool_states');
    expect(sql).toContain('runtime_box_workbench_tool_revisions');
    expect(sql).toContain("'recovery_required'");
    expect(sql).toContain('manifest_hash');
    expect(sql).toContain('requested_by_user_id');
    expect(sql).toContain('session_id');
    expect(sql).toContain('job_id');
  });

  it('limits prefixes to the managed project-relative revision directory', () => {
    expect(sql).toContain("prefix_relpath ~ '^\\.runtime-box/workbench-tools/revisions/[0-9]{6}$'");
  });
});
