-- 174: Recent visible Session list startup index.
--
-- The frontend now requests only the recent sidebar window (for example limit=200),
-- and getSessions selects that window before message-derived metadata joins.
-- This partial index lets Postgres satisfy the archived filter + updated_at DESC
-- ordering without sorting/scanning the whole sessions table.

CREATE INDEX IF NOT EXISTS idx_sessions_recent_active_updated
  ON sessions(updated_at DESC)
  WHERE archived IS NULL OR archived = 0;
