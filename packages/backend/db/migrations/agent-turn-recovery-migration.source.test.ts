import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.resolve(import.meta.dirname, './136_agent_turn_recovery_claim.sql'), 'utf8');

describe('agent turn recovery migration', () => {
  it('indexes root-turn recovery state stored on user message metadata', () => {
    expect(sql).toContain('idx_messages_agent_turn_recovery');
    expect(sql).toContain("metadata->'agent_turn'->>'recovery_status'");
    expect(sql).toContain("role = 'user'");
  });
});
