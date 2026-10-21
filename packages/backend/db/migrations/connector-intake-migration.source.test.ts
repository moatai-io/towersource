import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./201_connector_intake.sql', import.meta.url), 'utf8');

describe('Connector intake migration', () => {
  it('keeps provider-neutral metadata, connector-scoped delivery dedupe, and task provenance', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS connectors');
    expect(sql).toContain('provider TEXT NOT NULL');
    expect(sql).toContain('run_as_user_id INTEGER NOT NULL REFERENCES users(id)');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS connector_events');
    expect(sql).toContain('UNIQUE (connector_id, delivery_id)');
    expect(sql).toContain('payload_hash TEXT NOT NULL');
    expect(sql).toContain('task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL');
    expect(sql).toContain("'needs_review'");
  });

  it('does not persist provider secret values', () => {
    expect(sql).not.toMatch(/secret_value|api_key|signing_secret/i);
  });
});
