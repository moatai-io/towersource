import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.resolve(import.meta.dirname, './138_agent_turns.sql'), 'utf8');

describe('agent turns migration', () => {
  it('creates one durable state row per root turn with due retry scheduling', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS agent_turns');
    expect(sql).toContain('root_turn_id TEXT PRIMARY KEY');
    expect(sql).toContain("'waiting_retry'");
    expect(sql).toContain('owner_token TEXT');
    expect(sql).toContain('next_attempt_at TIMESTAMPTZ');
    expect(sql).toContain('idx_agent_turns_due_retry');
  });
});
