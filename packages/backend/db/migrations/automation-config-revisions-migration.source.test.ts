import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./147_automation_config_revisions.sql', import.meta.url), 'utf8');

describe('automation config revisions migration', () => {
  it('creates an append-only per-automation revision ledger', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS automation_config_revisions');
    expect(sql).toContain('revision_no INTEGER NOT NULL');
    expect(sql).toContain('UNIQUE(automation_id, revision_no)');
    expect(sql).toContain('config_snapshot JSONB NOT NULL');
    expect(sql).toContain("mutation_source TEXT NOT NULL DEFAULT 'change_intent'");
    expect(sql).toContain('reason TEXT');
  });

  it('binds one revision directly to one change intent', () => {
    expect(sql).toContain('change_intent_id UUID REFERENCES automation_change_intents(id)');
    expect(sql).toContain('UNIQUE(change_intent_id)');
    expect(sql).toContain('proposal_hash TEXT');
  });
});
