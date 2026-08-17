import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.resolve(import.meta.dirname, './146_agent_turn_timing_lifecycle.sql'), 'utf8');

describe('agent turn timing lifecycle migration', () => {
  it('adds durable wall, execution, waiting-user, and terminal boundaries', () => {
    expect(sql).toContain('accepted_at TIMESTAMPTZ');
    expect(sql).toContain('execution_started_at TIMESTAMPTZ');
    expect(sql).toContain('waiting_user_started_at TIMESTAMPTZ');
    expect(sql).toContain('waiting_user_ms BIGINT NOT NULL DEFAULT 0');
    expect(sql).toContain('terminal_at TIMESTAMPTZ');
    expect(sql).toContain('idx_agent_turns_session_active_timing');
  });
});
