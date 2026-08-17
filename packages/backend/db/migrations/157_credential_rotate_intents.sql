CREATE TABLE IF NOT EXISTS credential_rotate_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL REFERENCES workspace_credentials(id) ON DELETE CASCADE,
  proposal_hash TEXT NOT NULL,
  secret_commitment TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'applying', 'applied', 'failed')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credential_rotate_intents_actor_created_idx
  ON credential_rotate_intents(actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS credential_rotate_intents_expiry_idx
  ON credential_rotate_intents(expires_at)
  WHERE status = 'previewed';
