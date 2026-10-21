-- 211_gateway_profiles.sql
-- Secret-free VM-level control-plane/read model for shared API gateway state.
-- This deliberately does not restore the retired credential_profiles policy system.

CREATE TABLE IF NOT EXISTS gateway_profiles (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  display_name TEXT NOT NULL,
  gateway_provider TEXT NOT NULL,
  gateway_base_url TEXT,
  credential_id TEXT REFERENCES workspace_credentials(id) ON DELETE SET NULL,
  consumer_ref TEXT,
  desired_state_hash TEXT CHECK (desired_state_hash IS NULL OR desired_state_hash ~ '^[0-9a-f]{64}$'),
  applied_state_hash TEXT CHECK (applied_state_hash IS NULL OR applied_state_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','degraded','disabled')),
  last_verified_at TIMESTAMPTZ,
  last_error_code TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gateway_profile_catalog_entries (
  profile_id TEXT NOT NULL REFERENCES gateway_profiles(id) ON DELETE CASCADE,
  api_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  route_prefix TEXT NOT NULL CHECK (route_prefix LIKE '/%'),
  capability TEXT NOT NULL,
  client_base_env TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  cost_meter TEXT NOT NULL DEFAULT 'requests',
  quota_mode TEXT NOT NULL DEFAULT 'observe' CHECK (quota_mode IN ('observe','soft','hard','budget')),
  readiness TEXT NOT NULL DEFAULT 'unverified' CHECK (readiness IN ('ready','degraded','unverified','disabled')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (profile_id, api_id)
);

CREATE INDEX IF NOT EXISTS idx_gateway_profiles_status ON gateway_profiles(status);
CREATE INDEX IF NOT EXISTS idx_gateway_catalog_profile_enabled ON gateway_profile_catalog_entries(profile_id, enabled, api_id);

INSERT INTO gateway_profiles (id, version, display_name, gateway_provider, status, metadata)
VALUES ('tower-shared-api-v1', 1, 'Tower Shared APIs v1', 'zuplo', 'pending', '{"source":"migration_211","controlPlane":"secret-free"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO gateway_profile_catalog_entries
  (profile_id, api_id, display_name, route_prefix, capability, client_base_env, cost_meter)
VALUES
  ('tower-shared-api-v1', 'firecrawl', 'Firecrawl', '/fc', 'web_fetch', 'FIRECRAWL_API_URL', 'credits'),
  ('tower-shared-api-v1', 'apify', 'Apify', '/apify', 'actor_runs', NULL, 'compute_units'),
  ('tower-shared-api-v1', 'naver', 'Naver Search', '/naver', 'search', NULL, 'requests'),
  ('tower-shared-api-v1', 'openai', 'OpenAI API', '/openai', 'ai_api', NULL, 'tokens'),
  ('tower-shared-api-v1', 'agent-store', 'Agent Store', '/agent-store', 'mcp_tools', NULL, 'credits')
ON CONFLICT (profile_id, api_id) DO NOTHING;

COMMENT ON TABLE gateway_profiles IS
  'Secret-free VM Gateway Profile state. References one workspace Credential without storing key values.';
COMMENT ON TABLE gateway_profile_catalog_entries IS
  'Non-secret shared API catalog and per-API readiness for a Gateway Profile.';
