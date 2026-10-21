CREATE TABLE IF NOT EXISTS google_connection_cleanup_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  inventory_hash TEXT NOT NULL CHECK (inventory_hash ~ '^[0-9a-f]{64}$'),
  proposal_hash TEXT NOT NULL CHECK (proposal_hash ~ '^[0-9a-f]{64}$'),
  plan JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'applying', 'applied', 'failed')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS google_connection_cleanup_intents_actor_idx
  ON google_connection_cleanup_intents(actor_user_id, created_at DESC);

COMMENT ON TABLE google_connection_cleanup_intents IS
  'Short-lived, secret-free previews for consolidating Google Connection metadata and Agent policies.';
