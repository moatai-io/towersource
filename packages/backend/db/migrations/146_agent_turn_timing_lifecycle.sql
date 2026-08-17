-- 144: Durable wall-clock lifecycle for one root user turn.
-- accepted_at is the user-visible start boundary. Human wait is accumulated
-- separately so wall elapsed and active execution elapsed can be derived.

ALTER TABLE agent_turns
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS execution_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS waiting_user_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS waiting_user_ms BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS terminal_at TIMESTAMPTZ;

UPDATE agent_turns
   SET accepted_at = COALESCE(accepted_at, created_at)
 WHERE accepted_at IS NULL;

ALTER TABLE agent_turns
  ALTER COLUMN accepted_at SET DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_agent_turns_session_active_timing
  ON agent_turns(session_id, accepted_at DESC)
  WHERE state IN ('running', 'waiting_retry');
