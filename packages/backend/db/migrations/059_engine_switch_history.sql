-- ============================================================
-- 059: Engine switch history + per-engine session identifiers
--
-- Lets a session change its `engine` (claude / pi / local) mid-life
-- via hard switch — see workspace/decisions/2026-05-19-engine-hard-switch-design.md.
--
-- Why two changes in one migration:
--   1. sessions.pi_session_file — Pi engine needs its own per-session resume
--      identifier (a path to ~/.pi/sessions/<uuid>.jsonl).  Before this column
--      Pi reused claude_session_id which was overloaded and confusing.  Each
--      engine that joins the platform gets its own column following the same
--      pattern (<engine>_session_id or <engine>_session_file).
--   2. session_engine_history — audit trail of every engine switch.  Used by
--      Mission Control / debug UI to answer "when did this session move from
--      claude → pi, and why".
--
-- Idempotent: both objects use IF NOT EXISTS.
--
-- See:
--   workspace/decisions/2026-05-19-engine-hard-switch-design.md
--   packages/backend/engines/types.ts (Engine.rehydrateFromMessages)
-- ============================================================

-- ── 1. Per-engine session-identifier columns ───────────────────────
--
-- claude_session_id already exists from migration 008.  Pi previously
-- piggy-backed on it which made hard switch impossible (one column
-- cannot hold two engines' state).  Splitting them lets a single
-- sessions row remember both — e.g. a session that was Claude on
-- turns 1-5 and Pi from turn 6 keeps the Claude .jsonl path for
-- archival while pi_session_file points at the active resume file.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS pi_session_file TEXT;

-- ── 2. Engine switch history ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS session_engine_history (
  id              SERIAL PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

  -- NULL means "this is the initial row recording how the session was created"
  -- (created_at-style anchor).  Non-NULL means a real switch happened.
  from_engine     TEXT,
  to_engine       TEXT NOT NULL,

  -- Snapshot of sessions.turn_count at the moment of switch.  Lets us answer
  -- "from which turn onward was Pi answering" without re-deriving from messages.
  at_turn         INTEGER NOT NULL DEFAULT 0,

  -- ID of the first message produced under the new engine, if known.  May be
  -- NULL when the row is inserted *before* the first new-engine turn lands.
  at_message_id   TEXT,

  -- Human-readable trigger.  Free-form on purpose so we don't burn an enum
  -- before usage patterns settle.  Suggested values:
  --   'create'        — initial row at session creation (from_engine IS NULL)
  --   'user_request'  — user clicked Switch Engine in the UI
  --   'migration'     — bulk job moved this session during a platform-wide cutover
  --   'fallback'      — automatic switch after engine failure (NOT in phase 1)
  reason          TEXT,

  -- Optional snapshot of the previous engine's session identifier at the
  -- moment of switch.  Useful for forensic resume attempts later.
  from_session_id TEXT,
  to_session_id   TEXT,

  switched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  switched_by     INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_seh_session_time
  ON session_engine_history(session_id, switched_at DESC);

-- ── 3. Backfill "create" rows so the audit trail is complete ──────
--
-- Every existing session got created under its current engine.  Without a
-- backfill row, history queries would have a blind spot at the start.

INSERT INTO session_engine_history (session_id, from_engine, to_engine, at_turn, reason, switched_at)
SELECT id, NULL, COALESCE(engine, 'claude'), 0, 'create', created_at
FROM sessions
WHERE NOT EXISTS (
  SELECT 1 FROM session_engine_history h WHERE h.session_id = sessions.id
);
