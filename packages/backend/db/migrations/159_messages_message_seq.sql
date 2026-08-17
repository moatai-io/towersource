-- 159 (1/4): Canonical per-session message ordering for exact conversation prefix branches.
-- created_at remains the human timestamp; message_seq is the durable ordering authority.
--
-- Split into 159_messages_message_seq*.sql (this file + _2/_3/_4 backfill/notnull/index)
-- because the migration runner wraps each file in its own transaction. Keeping the
-- backfill and index builds in this same file/transaction would hold the
-- AccessExclusiveLock taken by ADD COLUMN for the entire backfill — which, on this
-- table, has to update a ~2GB trigram index and a full-text tsv index per row and
-- can run long enough to freeze every chat read/write in the app. Splitting lets
-- the slow step run under a RowExclusiveLock instead (see _2_backfill.sql).

CREATE SEQUENCE IF NOT EXISTS messages_message_seq_seq;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS message_seq BIGINT;

ALTER TABLE messages
  ALTER COLUMN message_seq SET DEFAULT nextval('messages_message_seq_seq');

ALTER SEQUENCE messages_message_seq_seq OWNED BY messages.message_seq;
