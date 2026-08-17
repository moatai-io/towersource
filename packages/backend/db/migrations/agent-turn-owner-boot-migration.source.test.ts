import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.resolve(import.meta.dirname, './139_agent_turn_owner_boot.sql'), 'utf8');

describe('agent turn owner boot migration', () => {
  it('stores a backend boot identity for active recovery owners', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS owner_boot_id TEXT');
    expect(sql).toContain('idx_agent_turns_owner_boot');
    expect(sql).toContain("state = 'running'");
  });
});
