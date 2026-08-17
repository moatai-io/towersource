import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(import.meta.dirname, './135_ai_service_channel_credential_revocations.sql'), 'utf8');

describe('AI Service Channel credential revocation migration', () => {
  it('creates a token-hash revocation ledger for public Channel credentials', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS ai_service_channel_credential_revocations');
    expect(migration).toContain('token_hash TEXT NOT NULL UNIQUE');
    expect(migration).toContain('revoked_by_user_id INTEGER REFERENCES users');
    expect(migration).toContain('idx_ai_service_channel_credential_revocations_token');
  });
});
