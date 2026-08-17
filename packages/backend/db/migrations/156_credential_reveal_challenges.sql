CREATE TABLE IF NOT EXISTS credential_reveal_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL REFERENCES workspace_credentials(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('reveal', 'compare', 'inspect')),
  requester_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'failed')),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 3),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credential_reveal_challenges_actor_created_idx
  ON credential_reveal_challenges(actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS credential_reveal_challenges_actor_requester_idx
  ON credential_reveal_challenges(actor_user_id, requester_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS credential_reveal_challenges_expiry_idx
  ON credential_reveal_challenges(expires_at)
  WHERE status = 'pending';
