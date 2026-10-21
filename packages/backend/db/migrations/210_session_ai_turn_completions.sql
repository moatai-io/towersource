-- 210_session_ai_turn_completions.sql
-- Follow-up for deployments that applied 202_session_user_states before the
-- AI completion idempotency ledger was added to that already-recorded file.

CREATE TABLE IF NOT EXISTS session_ai_turn_completions (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  root_turn_id TEXT NOT NULL,
  assistant_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  ai_sequence BIGINT NOT NULL CHECK (ai_sequence > 0),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, root_turn_id),
  UNIQUE (session_id, ai_sequence)
);

COMMENT ON TABLE session_ai_turn_completions IS
  'Idempotency ledger mapping each completed root turn to exactly one Session AI sequence.';
