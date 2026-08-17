import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/151_runtime_box_workbench_tool_commands.sql'), 'utf8');

describe('Workbench tool command migration', () => {
  it('stores restart-safe one-time intents and actor-scoped idempotent commands', () => {
    expect(sql).toContain('runtime_box_workbench_tool_change_intents');
    expect(sql).toContain('runtime_box_workbench_tool_commands');
    expect(sql).toContain('UNIQUE(actor_user_id, idempotency_key)');
    expect(sql).toContain('consumed_by_command_id');
    expect(sql).toContain('proposal_hash');
    expect(sql).toContain('request_hash');
  });

  it('records recovery-required command outcomes without storing credential material', () => {
    expect(sql).toContain("'recovery_required'");
    expect(sql).toContain('error_code');
    expect(sql).not.toMatch(/credential(_|\s)*(value|secret|payload)/i);
  });
});
