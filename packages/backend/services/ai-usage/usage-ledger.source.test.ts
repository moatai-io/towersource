import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const src = fs.readFileSync(path.resolve(import.meta.dirname, './usage-ledger.ts'), 'utf8');

describe('Pi usage ledger wiring', () => {
  it('attributes turns to users, projects, persistent agents and LiteLLM evidence', () => {
    expect(src).toContain('agent_turn_router_evidence');
    expect(src).toContain('aw.backing_session_id = s.id');
    expect(src).toContain("'persistent_agent'");
    expect(src).toContain("'spawned_session'");
    expect(src).toContain("COALESCE(NULLIF(re.evidence->>'provider_model'");
    expect(src).toContain('ON CONFLICT (root_turn_id) DO NOTHING');
    expect(src).toContain("error?.code !== '42P01'");
    // INSERT columns and SELECT values must align: preset attribution precedes
    // the requested Router model, not the workload-policy revision slot.
    expect(src).toContain("'pi', $4, $5, $15, $16,\n           $6, re.model,");
  });
});
