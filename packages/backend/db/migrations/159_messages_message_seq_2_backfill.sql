-- 159 (2/4): Backfill message_seq for historical rows.
-- Deliberately its own migration file/transaction (see 159_messages_message_seq.sql
-- for why) so this only takes a RowExclusiveLock — other sessions can keep reading
-- and writing messages while the trigram/tsv GIN indexes absorb this update.
--
-- Preserve the existing visible order for historical rows. ctid is used only as
-- a one-time deterministic tie breaker where legacy timestamps are identical.
WITH ranked AS (
  SELECT id, row_number() OVER (ORDER BY created_at ASC, ctid ASC) AS seq
    FROM messages
   WHERE message_seq IS NULL
)
UPDATE messages m
   SET message_seq = ranked.seq
  FROM ranked
 WHERE m.id = ranked.id;

SELECT setval(
  'messages_message_seq_seq',
  GREATEST(COALESCE((SELECT MAX(message_seq) FROM messages), 0) + 1, 1),
  false
);
