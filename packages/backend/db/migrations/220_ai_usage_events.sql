-- 220: Append-only AI usage ledger for Pi/LiteLLM turns.
-- Observe-only: this ledger does not grant execution authority or enforce quota.

CREATE TABLE IF NOT EXISTS ai_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  root_turn_id TEXT NOT NULL,
  parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agent_workers(id) ON DELETE SET NULL,
  agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  execution_kind TEXT NOT NULL DEFAULT 'interactive'
    CHECK (execution_kind IN ('interactive','spawned_session','persistent_agent','automation','ai_service','system_internal')),
  engine TEXT NOT NULL DEFAULT 'pi' CHECK (engine = 'pi'),
  model_policy_id TEXT,
  model_policy_revision INTEGER,
  requested_model TEXT,
  router_model TEXT,
  provider_model TEXT,
  provider TEXT,
  input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cache_creation_tokens >= 0),
  reasoning_tokens BIGINT NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  provider_cost_usd NUMERIC(18,8),
  cost_basis TEXT NOT NULL DEFAULT 'unavailable'
    CHECK (cost_basis IN ('provider_reported','router_spend_log','rate_card_calculated','unavailable')),
  router_request_id TEXT,
  provider_response_id TEXT,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','failed','aborted')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (root_turn_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_events_user_occurred
  ON ai_usage_events(actor_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_project_occurred
  ON ai_usage_events(project_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_agent_occurred
  ON ai_usage_events(agent_id, occurred_at DESC) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_provider_model_occurred
  ON ai_usage_events(provider_model, occurred_at DESC) WHERE provider_model IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_router_request
  ON ai_usage_events(router_request_id) WHERE router_request_id IS NOT NULL;
