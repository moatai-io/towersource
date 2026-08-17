-- 138: One durable state row per root user turn.
-- Recovery sources update this row; only PiEngine owns claim/terminal transitions.

CREATE TABLE IF NOT EXISTS agent_turns (
  root_turn_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('running', 'waiting_retry', 'completed', 'failed', 'needs_attention')),
  recovery_source TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  owner_token TEXT,
  lease_until TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  last_failure_class TEXT,
  last_error TEXT,
  assistant_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_turns_due_retry
  ON agent_turns(next_attempt_at)
  WHERE state = 'waiting_retry';

CREATE INDEX IF NOT EXISTS idx_agent_turns_session
  ON agent_turns(session_id, updated_at DESC);
