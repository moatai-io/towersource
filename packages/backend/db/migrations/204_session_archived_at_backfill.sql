-- 204_session_archived_at_backfill.sql
-- Data-only backfill for 203. Rows archived before archived_at existed keep their
-- archive moment, then updated_at is repaired to true last-activity time from the
-- last message when available.

UPDATE sessions
   SET archived_at = updated_at
 WHERE archived = 1
   AND archived_at IS NULL;

UPDATE sessions s
   SET updated_at = COALESCE(
     (SELECT MAX(m.created_at) FROM messages m WHERE m.session_id = s.id),
     s.updated_at
   )
 WHERE s.archived = 1;
