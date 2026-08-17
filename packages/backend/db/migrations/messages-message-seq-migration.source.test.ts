import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Split across four files/transactions so the migration runner (one BEGIN/COMMIT
// per file) never holds the ADD COLUMN lock through the slow GIN-index-heavy
// backfill. See 159_messages_message_seq.sql for the full rationale.
const migration = [
  '159_messages_message_seq.sql',
  '159_messages_message_seq_2_backfill.sql',
  '159_messages_message_seq_3_notnull.sql',
  '159_messages_message_seq_4_index.sql',
].map((file) => fs.readFileSync(path.resolve(import.meta.dirname, file), 'utf8')).join('\n');
const store = fs.readFileSync(path.resolve(import.meta.dirname, '../../services/message-store.ts'), 'utf8');

describe('messages message_seq migration contract', () => {
  it('adds a non-null monotonic ordering authority and per-session indexes', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS message_seq BIGINT');
    expect(migration).toContain("SET DEFAULT nextval('messages_message_seq_seq')");
    expect(migration).toContain('ALTER COLUMN message_seq SET NOT NULL');
    expect(migration).toContain('idx_messages_session_message_seq');
  });

  it('uses message_seq for canonical reads with a legacy ordering fallback while managed migration is deferred', () => {
    expect(store).toContain("const order = await hasMessageSeq() ? 'message_seq ASC' : 'created_at ASC, id ASC'");
    expect(store).toContain("useMessageSeq ? 'message_seq DESC' : 'created_at DESC, id DESC'");
    expect(store).toContain('message_seq < $2 ORDER BY message_seq DESC');
    expect(store).toContain('(created_at, id) < ($2, $3) ORDER BY created_at DESC, id DESC');
  });
});
