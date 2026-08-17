-- ============================================================
-- 049: sessions.kind — first-class classification for Mission Control
--
-- Separates "user-driven sessions" from "autonomous runs spawned by schedulers
-- / proactive monitors / agents". The existing `label` column is more granular
-- (task/proactive/channel_ai/temp) and serves runtime UI; `kind` is the
-- coarser filter for Mission Control aggregation.
--
--   'user'           — default; created by a human or in response to one
--   'autonomous_run' — spawned by scheduler / cron / proactive monitor
--                      Becomes browsable as a Run record in D16 Reading Room.
--
-- See: workspace/decisions/2026-05-04-tower-channel-and-persona.md
--      tower/docs/plans/2026-05-04-tower-channel-implementation.md
-- ============================================================

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'user';

-- Partial index — Mission Control queries filter on autonomous_run. Skipping
-- the bulk of 'user' rows keeps the index small.
CREATE INDEX IF NOT EXISTS idx_sessions_kind_autonomous
  ON sessions (kind, updated_at DESC)
  WHERE kind = 'autonomous_run';

-- App-level validation: kind ∈ {'user','autonomous_run'}.
-- Backfill is intentionally NOT performed here — old proactive/task sessions
-- stay 'user' until their next interaction (or until a follow-up migration
-- targets them). This keeps the migration cheap and reversible.
