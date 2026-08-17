-- 161: Diagnostic Router/provider evidence for one durable Tower root turn.
-- This table is observability/reconciliation input only. It never grants
-- `agent_turns.state = completed`; durable assistant persistence remains required.

CREATE TABLE IF NOT EXISTS agent_turn_router_evidence (
  id BIGSERIAL PRIMARY KEY,
  root_turn_id TEXT NOT NULL REFERENCES agent_turns(root_turn_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tower_run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  request_id TEXT,
  response_id TEXT,
  terminal_type TEXT,
  http_status INTEGER,
  model TEXT,
  service_tier TEXT,
  duration_ms INTEGER,
  error_code TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (root_turn_id, tower_run_id, request_id, terminal_type)
);

CREATE INDEX IF NOT EXISTS idx_agent_turn_router_evidence_root
  ON agent_turn_router_evidence(root_turn_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_turn_router_evidence_request
  ON agent_turn_router_evidence(request_id)
  WHERE request_id IS NOT NULL;
