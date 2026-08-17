-- ============================================================
-- 006: Full-text search index on room messages (pg_trgm)
-- ============================================================

CREATE INDEX idx_room_messages_content_trgm
  ON room_messages USING GIN (content gin_trgm_ops);
