import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.resolve(import.meta.dirname, './155_agent_turn_safe_stop.sql'), 'utf8');

describe('agent turn safe-stop migration', () => {
  it('adds durable requested and terminal stop states', () => {
    expect(sql).toContain("'stop_requested'");
    expect(sql).toContain("'stopped_clean'");
    expect(sql).toContain("'stopped_forced'");
    expect(sql).toContain('stop_requested_at TIMESTAMPTZ');
    expect(sql).toContain('idx_agent_turns_stop_requested');
  });
});
