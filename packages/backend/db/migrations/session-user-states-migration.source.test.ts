import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(
  path.join(process.cwd(), 'packages/backend/db/migrations/202_session_user_states.sql'),
  'utf8',
);
const indexSql = fs.readFileSync(
  path.join(process.cwd(), 'packages/backend/db/migrations/209_session_user_states_indexes.sql'),
  'utf8',
);
const completionFollowUp = fs.readFileSync(
  path.join(process.cwd(), 'packages/backend/db/migrations/210_session_ai_turn_completions.sql'),
  'utf8',
);

describe('session AI-response unread migration', () => {
  it('adds a monotonic Session completion sequence', () => {
    expect(sql).toContain('last_final_ai_sequence BIGINT NOT NULL DEFAULT 0');
  });

  it('stores one subscription and read cursor row per user and Session', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS session_user_states');
    expect(sql).toContain('PRIMARY KEY (user_id, session_id)');
    expect(sql).toContain("CHECK (subscription_state IN ('subscribed', 'muted'))");
    expect(sql).toContain('subscribed_from_sequence BIGINT NOT NULL DEFAULT 0');
    expect(sql).toContain('last_read_ai_sequence BIGINT NOT NULL DEFAULT 0');
  });

  it('keeps subscribed-list lookup indexed in a separate migration transaction', () => {
    expect(sql).not.toContain('CREATE INDEX');
    expect(indexSql).toContain('idx_session_user_states_subscribed');
    expect(indexSql).toContain("WHERE subscription_state = 'subscribed'");
  });

  it('deduplicates completed root turns before assigning a Session sequence', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS session_ai_turn_completions');
    expect(sql).toContain('PRIMARY KEY (session_id, root_turn_id)');
    expect(sql).toContain('UNIQUE (session_id, ai_sequence)');
    expect(sql).toContain('assistant_message_id TEXT NOT NULL REFERENCES messages(id)');
  });

  it('ships a new migration for deployments that recorded 202 before the completion ledger was added', () => {
    expect(completionFollowUp).toContain('CREATE TABLE IF NOT EXISTS session_ai_turn_completions');
    expect(completionFollowUp).toContain('PRIMARY KEY (session_id, root_turn_id)');
    expect(completionFollowUp).toContain('UNIQUE (session_id, ai_sequence)');
  });
});
