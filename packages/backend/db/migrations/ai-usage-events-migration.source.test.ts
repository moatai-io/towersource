import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.resolve(import.meta.dirname, './220_ai_usage_events.sql'), 'utf8');

describe('AI usage events migration', () => {
  it('creates an observe-only Pi/LiteLLM ledger with user, agent and model attribution', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS ai_usage_events');
    expect(sql).toContain('actor_user_id INTEGER REFERENCES users(id)');
    expect(sql).toContain('agent_id TEXT REFERENCES agent_workers(id)');
    expect(sql).toContain('model_policy_id TEXT');
    expect(sql).toContain('requested_model TEXT');
    expect(sql).toContain('router_model TEXT');
    expect(sql).toContain('provider_model TEXT');
    expect(sql).toContain("engine TEXT NOT NULL DEFAULT 'pi' CHECK (engine = 'pi')");
    expect(sql).toContain('UNIQUE (root_turn_id)');
  });
});
