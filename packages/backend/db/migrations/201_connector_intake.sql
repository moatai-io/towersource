-- 201: Provider-neutral Connector registry and durable inbound event ledger.
-- Connector secrets remain in Credential Vault/deployment secret injection, never this table.

CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  display_name TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_as_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  connection_id TEXT,
  enabled BOOLEAN NOT NULL DEFAULT false,
  configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS connector_events (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  event_type TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_id TEXT,
  resource_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'ignored', 'task_created', 'failed', 'needs_review')),
  route TEXT,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  reason TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (connector_id, delivery_id)
);

CREATE INDEX IF NOT EXISTS idx_connector_events_resource_received
  ON connector_events(provider, resource_id, received_at DESC)
  WHERE resource_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_connector_events_review
  ON connector_events(status, received_at DESC)
  WHERE status IN ('failed', 'needs_review');
