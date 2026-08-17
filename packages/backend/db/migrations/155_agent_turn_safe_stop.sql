-- 155: Durable safe-stop lifecycle for root agent turns.

ALTER TABLE agent_turns DROP CONSTRAINT IF EXISTS agent_turns_state_check;
ALTER TABLE agent_turns
  ADD CONSTRAINT agent_turns_state_check
  CHECK (state IN ('running', 'stop_requested', 'waiting_retry', 'completed', 'stopped_clean', 'stopped_forced', 'failed', 'needs_attention'));

ALTER TABLE agent_turns
  ADD COLUMN IF NOT EXISTS stop_mode TEXT CHECK (stop_mode IN ('safe', 'force')),
  ADD COLUMN IF NOT EXISTS stop_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stopped_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_agent_turns_stop_requested
  ON agent_turns(updated_at)
  WHERE state = 'stop_requested';
