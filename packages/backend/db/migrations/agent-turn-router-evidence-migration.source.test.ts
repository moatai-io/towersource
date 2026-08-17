import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.resolve(import.meta.dirname, './161_agent_turn_router_evidence.sql'), 'utf8');

describe('agent turn router evidence migration', () => {
  it('stores diagnostic evidence without changing agent_turns completion state', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS agent_turn_router_evidence');
    expect(sql).toContain('root_turn_id TEXT NOT NULL REFERENCES agent_turns(root_turn_id)');
    expect(sql).toContain('tower_run_id TEXT NOT NULL');
    expect(sql).toContain('terminal_type TEXT');
    expect(sql).toContain('UNIQUE (root_turn_id, tower_run_id, request_id, terminal_type)');
    expect(sql).not.toMatch(/UPDATE\s+agent_turns/i);
  });
});
