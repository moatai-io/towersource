-- 159 (3/4): Enforce NOT NULL once every row has been backfilled by
-- 159_messages_message_seq_2_backfill.sql. Brief AccessExclusiveLock — this is a
-- validation-only scan (no rewrite, no index maintenance), so it should be fast
-- even though the ALTER itself needs the exclusive lock.

ALTER TABLE messages
  ALTER COLUMN message_seq SET NOT NULL;
