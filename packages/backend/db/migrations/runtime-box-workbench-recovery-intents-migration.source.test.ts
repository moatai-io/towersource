import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrations = path.resolve(import.meta.dirname);
const source = fs.readFileSync(path.join(migrations, '160_runtime_box_workbench_recovery_intents.sql'), 'utf8');

describe('Workbench recovery intent migration', () => {
  it('adds one-time recovery approvals after the existing Workbench ledger migrations', () => {
    expect(fs.existsSync(path.join(migrations, '154_runtime_box_workbench_import_action.sql'))).toBe(true);
    expect(source).toContain('runtime_box_workbench_recovery_intents');
    expect(source).toContain("action_kind IN ('cleanup-orphan-candidate')");
    expect(source).toContain("expected_command_status IN ('reserved','running')");
  });

  it('preserves command evidence and limits authority to one consumed intent', () => {
    expect(source).toContain('REFERENCES runtime_box_workbench_tool_commands(id) ON DELETE RESTRICT');
    expect(source).toContain('inspection_snapshot JSONB NOT NULL');
    expect(source).toContain('proposal_hash TEXT NOT NULL');
    expect(source).toContain('consumed_at TIMESTAMPTZ');
    expect(source).not.toMatch(/DELETE FROM runtime_box_workbench_tool_commands/i);
  });
});
