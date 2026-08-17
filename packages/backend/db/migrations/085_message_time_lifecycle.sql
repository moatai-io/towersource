-- ============================================================
-- 085: Message time lifecycle
-- ============================================================
-- `messages.created_at` is an immutable row creation / ordering anchor.
-- Streaming content updates must not mutate it. Use:
--   - updated_at: last persisted message content/metadata update
--   - completed_at: assistant response metrics finalized
--
-- Decision: workspace/decisions/2026-06-08-message-time-lifecycle.md
-- Issue: https://github.com/juliuschun/tower/issues/77

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- Do NOT backfill or build an index in this migration.
--
-- The Tower migration runner wraps each file in one transaction. If we combine
-- ALTER TABLE with a large UPDATE / CREATE INDEX here, PostgreSQL keeps the
-- table-level lock from ALTER TABLE until the whole transaction commits. On the
-- hot `messages` table that can block normal desk traffic and exhaust connection
-- slots. Historical rows may keep `updated_at = NULL`; application reads should
-- use COALESCE(updated_at, created_at) when they need a fallback.
--
-- Any future backfill/index must be done as a separate online operation, e.g.
-- small batches and CREATE INDEX CONCURRENTLY outside the migration transaction.
