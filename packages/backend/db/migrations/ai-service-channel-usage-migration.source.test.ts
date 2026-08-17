import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(import.meta.dirname, './134_ai_service_channel_usage_events.sql'), 'utf8');

describe('AI Service Channel usage migration', () => {
  it('creates a usage ledger for credential and public serving events', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS ai_service_channel_usage_events');
    expect(migration).toContain("event_type IN ('credential_issued','conversation_created','message_turn')");
    expect(migration).toContain("exposure IN ('auth-required','unlisted','public')");
    expect(migration).toContain('idx_ai_service_channel_usage_channel_time');
    expect(migration).toContain('idx_ai_service_channel_usage_tenant_time');
  });
});
