-- 173: Durable inbox foundation for Agent Session-to-Session communication.
-- PostgreSQL owns acceptance, idempotency, and delivery state. Runtime
-- notifications remain best-effort doorbells and are not correctness evidence.

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  sender_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  recipient_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sender_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('request', 'reply', 'report', 'status', 'coordination', 'system')),
  body JSONB NOT NULL,
  delivery_policy TEXT NOT NULL CHECK (delivery_policy IN ('wake', 'inject', 'active-only', 'store-only')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high')),
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  in_reply_to_message_id TEXT REFERENCES agent_messages(id) ON DELETE SET NULL,
  root_conversation_id TEXT NOT NULL,
  worker_id TEXT,
  agent_run_id TEXT,
  source_root_turn_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  operation_id TEXT,
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted', 'queued', 'held', 'refused', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_sender_operation_unique
  ON agent_messages(sender_session_id, operation_id)
  WHERE operation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_messages_recipient_inbox
  ON agent_messages(recipient_session_id, created_at, id)
  WHERE status IN ('accepted', 'queued', 'held');

CREATE INDEX IF NOT EXISTS idx_agent_messages_correlation
  ON agent_messages(correlation_id, created_at);

CREATE TABLE IF NOT EXISTS agent_message_deliveries (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
  recipient_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending', 'claimed', 'injected_active', 'started_turn', 'processing',
    'responded', 'completed', 'retry_wait', 'failed', 'needs_attention'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  owner_token TEXT,
  owner_boot_id TEXT,
  lease_until TIMESTAMPTZ,
  delivery_mode_used TEXT CHECK (delivery_mode_used IN (
    'steer', 'queued-after-turn', 'new-turn', 'stored', 'held', 'refused'
  )),
  recipient_root_turn_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  response_message_id TEXT REFERENCES agent_messages(id) ON DELETE SET NULL,
  next_attempt_at TIMESTAMPTZ,
  failure_class TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT agent_message_deliveries_message_attempt_unique UNIQUE (message_id, attempt_count)
);

CREATE INDEX IF NOT EXISTS idx_agent_message_deliveries_pending
  ON agent_message_deliveries(recipient_session_id, next_attempt_at, created_at)
  WHERE state IN ('pending', 'retry_wait');

CREATE INDEX IF NOT EXISTS idx_agent_message_deliveries_lease
  ON agent_message_deliveries(lease_until)
  WHERE state = 'claimed';

COMMENT ON TABLE agent_messages IS
  'Durable Agent Session message envelopes; PostgreSQL acceptance is authoritative.';
COMMENT ON TABLE agent_message_deliveries IS
  'Retryable delivery attempts for durable Agent Session messages.';
