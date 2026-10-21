import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('./231_session_reasoning_effort.sql', import.meta.url), 'utf8');
describe('session reasoning effort migration', () => {
  it('adds a nullable constrained override', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS reasoning_effort TEXT');
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) expect(migration).toContain(`'${effort}'`);
    expect(migration).toContain('reasoning_effort IS NULL');
  });
});
