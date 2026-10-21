import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./turn-router-calls.ts', import.meta.url), 'utf8');

describe('bounded root-turn router evidence', () => {
  it('selects all terminal evidence by root turn instead of a single latest request', () => {
    expect(source).toContain('FROM agent_turn_router_evidence');
    expect(source).toContain('WHERE root_turn_id = $1');
    expect(source).toContain('request_id AS "requestId", terminal_type AS "terminalType"');
    expect(source).toContain('LIMIT 501');
    expect(source).toContain('if (rows.length > 500) throw');
    expect(source).not.toContain('request_id IS NOT NULL');
    expect(source).not.toContain('LIMIT 1\n');
  });
});
