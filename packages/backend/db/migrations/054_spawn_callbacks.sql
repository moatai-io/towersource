-- ============================================================
-- 054: spawn_callbacks — persist L3 spawn callback registry across restart
--
-- Phase 3 PR 2 (2026-05-10): the spawn-rpc in-memory `pending` Map was lost
-- on every backend restart. With auto-wake (Phase 3 PR 1) children may live
-- minutes to hours, so a restart in that window meant "parent never receives
-- child answer" — silent failure.
--
-- This table is the *backup* for that Map. The hot path stays in-memory
-- (Map<sessionId, SpawnCallback>); on every register/clear we mirror to DB.
-- On boot, we SELECT WHERE fired_at IS NULL and rebuild the Map.
--
-- ON DELETE CASCADE on spawned_session_id: if the child session is hard-deleted,
-- its callback is gone too. Soft-deleted (archived=1) children keep their
-- callbacks since the row still exists.
--
-- Decision: workspace/decisions/2026-05-09-l3-spawn-phase3-autonomous-orchestration.md
-- ============================================================

CREATE TABLE IF NOT EXISTS spawn_callbacks (
  spawn_id            TEXT PRIMARY KEY,
  spawned_session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  spawned_name        TEXT NOT NULL,
  mode                TEXT NOT NULL CHECK (mode IN ('inject-parent', 'inject-only', 'inject-and-wake', 'webhook', 'none')),
  webhook_url         TEXT,
  inject_template     TEXT NOT NULL,
  registered_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fired_at            TIMESTAMPTZ
);

-- Hot lookup: callbacks waiting to fire (most queries from boot recovery).
CREATE INDEX IF NOT EXISTS idx_spawn_callbacks_pending
  ON spawn_callbacks(spawned_session_id)
  WHERE fired_at IS NULL;

-- For listing per-parent (debug / admin).
CREATE INDEX IF NOT EXISTS idx_spawn_callbacks_parent
  ON spawn_callbacks(parent_session_id, registered_at DESC);
