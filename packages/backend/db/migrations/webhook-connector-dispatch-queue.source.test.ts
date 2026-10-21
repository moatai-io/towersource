import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync(new URL('./205_webhook_connector_dispatch_queue.sql', import.meta.url), 'utf8');
const normalizationSql = readFileSync(new URL('./206_webhook_event_status_normalization.sql', import.meta.url), 'utf8');
const constraintSql = readFileSync(new URL('./207_webhook_event_status_constraint.sql', import.meta.url), 'utf8');
const indexesSql = readFileSync(new URL('./208_webhook_event_dispatch_indexes.sql', import.meta.url), 'utf8');
const repairSql = readFileSync(new URL('./205a_webhook_connector_rename_repair.sql', import.meta.url), 'utf8');
describe('Webhook Connector dispatch queue migration', () => {
  it('adds normalized events, leases, attempts, and review-safe expired claims', () => {
    for (const fragment of ['normalized_event JSONB','attempts INTEGER','next_attempt_at TIMESTAMPTZ','claim_id TEXT','claim_until TIMESTAMPTZ','dispatched_at TIMESTAMPTZ']) expect(sql).toContain(fragment);
    expect(normalizationSql).toContain("'queued'");
    expect(normalizationSql).toContain("'accepted'");
    expect(constraintSql).toContain("'dispatching'");
    expect(constraintSql).toContain("'needs_review'");
    expect(sql).toContain('ALTER TABLE IF EXISTS connector_events RENAME TO webhook_events');
    expect(sql).toContain('ALTER TABLE IF EXISTS connectors RENAME TO webhook_connectors');
    expect(indexesSql).toContain('idx_webhook_events_dispatch_queue');
    expect(indexesSql).toContain('idx_webhook_events_expired_claims');
    expect(normalizationSql).toContain("UPDATE webhook_events SET status = 'queued'");
    expect(constraintSql).toContain('webhook_events_status_check');
  });

  it('repairs a recorded 205 migration whose legacy table names remain', () => {
    expect(repairSql).toContain("to_regclass('public.webhook_connectors') IS NULL");
    expect(repairSql).toContain("to_regclass('public.connectors') IS NOT NULL");
    expect(repairSql).toContain('ALTER TABLE connectors RENAME TO webhook_connectors');
    expect(repairSql).toContain('ALTER TABLE connector_events RENAME TO webhook_events');
    expect(repairSql).toContain('ALTER TABLE IF EXISTS webhook_events');
  });
});
