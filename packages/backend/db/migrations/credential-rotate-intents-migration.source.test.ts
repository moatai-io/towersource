import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./157_credential_rotate_intents.sql', import.meta.url), 'utf8');

describe('credential rotate intent migration', () => {
  it('stores only commitment and one-time intent metadata', () => {
    expect(source).toContain('credential_id TEXT NOT NULL');
    expect(source).toContain('proposal_hash TEXT NOT NULL');
    expect(source).toContain('secret_commitment TEXT NOT NULL');
    expect(source).toContain('expires_at TIMESTAMPTZ NOT NULL');
    expect(source).toContain("status IN ('previewed', 'applying', 'applied', 'failed')");
    expect(source).toContain('consumed_at TIMESTAMPTZ');
    expect(source).not.toMatch(/candidate|secret_value|password/i);
  });
});
