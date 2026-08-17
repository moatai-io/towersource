-- 126: P0 hardening for Primary Agent approval intents and versioned Runtime Profiles.

CREATE TABLE IF NOT EXISTS primary_agent_creation_intents (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  actor_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  staffing_hash TEXT NOT NULL,
  staffing_payload JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_primary_agent_creation_intents_actor_expiry
  ON primary_agent_creation_intents(actor_user_id, expires_at DESC);

-- harness_runtime_profile_versions is now the authoritative versioned profile store.
-- The legacy harness_runtime_profiles table remains for already-applied migrations,
-- but new publishing and runtime lookups no longer write or depend on its global id PK.
COMMENT ON TABLE harness_runtime_profile_versions IS
  'Authoritative immutable Runtime Profile versions. Legacy harness_runtime_profiles is compatibility-only.';
