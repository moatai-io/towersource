import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/153_credential_connection_change_intents.sql'), 'utf8');

describe('Credential Connection change intents migration', () => {
  it('stores short-lived exact preview state without secret material', () => {
    expect(sql).toContain('credential_connection_change_intents');
    expect(sql).toContain("CHECK (action IN ('connect', 'disconnect'))");
    expect(sql).toContain("CHECK (status IN ('previewed', 'applied', 'failed'))");
    expect(sql).toContain('project_id TEXT NOT NULL REFERENCES projects(id)');
    expect(sql).toContain('proposal_hash TEXT NOT NULL');
    expect(sql).toContain('expires_at TIMESTAMPTZ NOT NULL');
    expect(sql).toContain('consumed_at TIMESTAMPTZ');
    expect(sql).not.toMatch(/secret_value|credential_value|token_value|raw_secret/i);
  });
});
