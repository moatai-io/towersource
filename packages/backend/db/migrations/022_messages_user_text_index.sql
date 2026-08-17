-- ============================================================
-- 022: Messages — partial index for "real user turn" counting
-- ============================================================
--
-- Added 2026-04-10 alongside the Usage dashboard and sidebar turn badges.
--
-- Context: we define a "real user turn" as a message with
--   role='user' AND content LIKE '[{"type":"text"%'
-- (i.e. a human-typed message, not a tool_result bounce).
--
-- This definition is used both by:
--   - GET /api/metrics/usage-heatmap  (project-level aggregation)
--   - GET /api/sessions               (per-session badge in the sidebar)
--
-- The sessions-list query does a LEFT JOIN aggregation over ALL user-text
-- messages, so without a matching index it hits a full Seq Scan of the
-- messages table. Measured on dev: ~520ms for 130k messages / 548 sessions.
--
-- A partial index keyed on session_id, scoped to only the rows that match
-- the filter, collapses the plan to a Bitmap Index Scan + hash aggregation
-- and drops the query to ~14ms (≈37× speed-up) while staying tiny because
-- only ~4% of messages qualify.

CREATE INDEX IF NOT EXISTS idx_messages_user_text_session
  ON messages (session_id)
  WHERE role = 'user' AND content LIKE '[{"type":"text"%';
