import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./156_credential_reveal_challenges.sql', import.meta.url), 'utf8');

describe('credential reveal challenge migration', () => {
  it('binds one-time challenges to actor, credential, field, purpose and mode', () => {
    expect(source).toContain('actor_user_id INTEGER NOT NULL');
    expect(source).toContain('credential_id TEXT NOT NULL');
    expect(source).toContain('field_id TEXT NOT NULL');
    expect(source).toContain('purpose TEXT NOT NULL');
    expect(source).toContain('requester_hash TEXT NOT NULL');
    expect(source).toContain("mode IN ('reveal', 'compare', 'inspect')");
    expect(source).toContain('consumed_at TIMESTAMPTZ');
    expect(source).toContain('failed_attempts INTEGER NOT NULL DEFAULT 0');
  });
});
