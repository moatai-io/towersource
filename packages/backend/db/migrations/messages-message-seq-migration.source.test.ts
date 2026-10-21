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
    // Cursor predicates and ordering remain canonical even when active-context
    // filtering is inserted between them. Check each complete SQL statement so
    // unrelated reads cannot satisfy the contract and whitespace is irrelevant.
    const queries = [...store.matchAll(/`(SELECT \* FROM messages[^`]+)`/g)]
      .map((match) => match[1].replace(/\s+/g, ' ').trim());
    const activeContext = "AND COALESCE(metadata->>'contextState', 'active') = 'active'";
    expect(queries).toContain(
      `SELECT * FROM messages WHERE session_id = $1 AND message_seq < $2 ${activeContext} ORDER BY message_seq DESC LIMIT $3`,
    );
    expect(queries).toContain(
      `SELECT * FROM messages WHERE session_id = $1 AND (created_at, id) < ($2, $3) ${activeContext} ORDER BY created_at DESC, id DESC LIMIT $4`,
    );
  });
});
