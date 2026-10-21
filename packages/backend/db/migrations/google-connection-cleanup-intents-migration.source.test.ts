import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/190_google_connection_cleanup_intents.sql'), 'utf8');

describe('Google Connection cleanup intents migration', () => {
  it('stores a short-lived secret-free exact inventory preview', () => {
    expect(sql).toContain('google_connection_cleanup_intents');
    expect(sql).toContain('inventory_hash TEXT NOT NULL');
    expect(sql).toContain('proposal_hash TEXT NOT NULL');
    expect(sql).toContain('plan JSONB NOT NULL');
    expect(sql).toContain('expires_at TIMESTAMPTZ NOT NULL');
    expect(sql).not.toMatch(/secret_name|secret_value|token|encoded_config/i);
  });
});
