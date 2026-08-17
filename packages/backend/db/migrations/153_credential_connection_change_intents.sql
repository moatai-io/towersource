CREATE TABLE IF NOT EXISTS credential_connection_change_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id INTEGER NOT NULL,
  connection_id TEXT NOT NULL,
  connection_display_name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('credential', 'profile')),
  source_id TEXT NOT NULL,
  provider TEXT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('connect', 'disconnect')),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  proposal_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'applied', 'failed')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credential_connection_change_intents_actor_idx
  ON credential_connection_change_intents(actor_user_id, created_at DESC);
