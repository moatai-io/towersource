-- ============================================================
-- 011: Full-text search indexes (replaces SQLite FTS5 trigram)
-- ============================================================

-- pg_trgm extension (already created in initPg, but be safe)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Session search (name + summary)
CREATE INDEX idx_sessions_name_trgm
  ON sessions USING GIN (name gin_trgm_ops);
CREATE INDEX idx_sessions_summary_trgm
  ON sessions USING GIN (summary gin_trgm_ops)
  WHERE summary IS NOT NULL;

-- Message search (content body)
CREATE INDEX idx_messages_content_trgm
  ON messages USING GIN (content gin_trgm_ops);
