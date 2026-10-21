-- 203_session_archived_at_column.sql
-- Schema-only: archive timestamp column. Backfill runs in 204 so the ALTER does
-- not share a file with a table rewrite (migration lock-risk guard).

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

COMMENT ON COLUMN sessions.archived_at IS
  'Archive timestamp; NULL while the session is active. Restoring clears it.';
