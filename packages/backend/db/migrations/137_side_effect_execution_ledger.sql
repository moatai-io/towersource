-- 137: Durable at-most-once ledger for side-effectful Pi tools across continuation/restart.

CREATE TABLE IF NOT EXISTS side_effect_executions (
  id TEXT PRIMARY KEY,
  root_turn_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  semantic_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'uncertain')),
  owner_token TEXT NOT NULL,
  lease_until TIMESTAMPTZ,
  result_json JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_side_effect_execution_operation
  ON side_effect_executions(root_turn_id, operation_id);

CREATE INDEX IF NOT EXISTS idx_side_effect_execution_semantic
  ON side_effect_executions(root_turn_id, tool_name, semantic_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_side_effect_execution_running_lease
  ON side_effect_executions(lease_until)
  WHERE status = 'running';
