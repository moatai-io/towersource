import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.resolve(import.meta.dirname, './173_agent_message_inbox.sql'), 'utf8');

describe('agent message inbox migration', () => {
  it('separates durable message identity from retryable delivery attempts', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS agent_messages');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS agent_message_deliveries');
    expect(sql).toContain("status IN ('accepted', 'queued', 'held', 'refused', 'expired')");
    expect(sql).toContain("'pending', 'claimed', 'injected_active', 'started_turn', 'processing'");
    expect(sql).toContain('CONSTRAINT agent_message_deliveries_message_attempt_unique UNIQUE (message_id, attempt_count)');
  });

  it('provides idempotency, recipient ordering, and lease recovery indexes', () => {
    expect(sql).toContain('idx_agent_messages_sender_operation_unique');
    expect(sql).toContain('WHERE operation_id IS NOT NULL');
    expect(sql).toContain('idx_agent_messages_recipient_inbox');
    expect(sql).toContain('idx_agent_message_deliveries_pending');
    expect(sql).toContain('idx_agent_message_deliveries_lease');
    expect(sql).toContain("WHERE state = 'claimed'");
  });
});
