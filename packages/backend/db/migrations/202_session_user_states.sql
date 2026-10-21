-- 202_session_user_states.sql
-- Server-owned subscription and read cursor state for AI final-response unread.
-- Additive rollout: existing completion attention remains active until read paths switch.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS last_final_ai_sequence BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS session_user_states (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  participated_at TIMESTAMPTZ,
  subscription_state TEXT NOT NULL DEFAULT 'subscribed'
    CHECK (subscription_state IN ('subscribed', 'muted')),
  subscribed_from_sequence BIGINT NOT NULL DEFAULT 0
    CHECK (subscribed_from_sequence >= 0),
  last_read_ai_sequence BIGINT NOT NULL DEFAULT 0
    CHECK (last_read_ai_sequence >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, session_id)
);

CREATE TABLE IF NOT EXISTS session_ai_turn_completions (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  root_turn_id TEXT NOT NULL,
  assistant_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  ai_sequence BIGINT NOT NULL CHECK (ai_sequence > 0),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, root_turn_id),
  UNIQUE (session_id, ai_sequence)
);

COMMENT ON COLUMN sessions.last_final_ai_sequence IS
  'Monotonic count of idempotently persisted completed root AI turns.';
COMMENT ON TABLE session_user_states IS
  'Per-user Session participation, AI-response subscription, and monotonic read cursor.';
COMMENT ON TABLE session_ai_turn_completions IS
  'Idempotency ledger mapping each completed root turn to exactly one Session AI sequence.';
