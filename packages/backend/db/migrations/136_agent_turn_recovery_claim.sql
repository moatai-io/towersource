-- 136: Root-turn recovery CAS queries operate on messages.metadata->agent_turn.
-- This expression index keeps startup orphan/claim lookups bounded without adding
-- a second source-of-truth table.

CREATE INDEX IF NOT EXISTS idx_messages_agent_turn_recovery
  ON messages(id, ((metadata->'agent_turn'->>'recovery_status')))
  WHERE role = 'user' AND metadata ? 'agent_turn';
