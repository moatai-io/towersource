-- 128: Immutable runtime-contract evaluations used by the AI Service activation gate.
-- A successful Preview records the exact Deployment and Harness fingerprint it exercised.

CREATE TABLE IF NOT EXISTS ai_service_runtime_evaluations (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  service_id TEXT NOT NULL REFERENCES ai_services(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL REFERENCES ai_service_deployments(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES ai_service_conversations(id) ON DELETE SET NULL,
  deployment_snapshot_hash TEXT NOT NULL,
  harness_id TEXT NOT NULL,
  harness_version INTEGER NOT NULL CHECK (harness_version > 0),
  runtime_profile_id TEXT NOT NULL,
  runtime_profile_version INTEGER NOT NULL CHECK (runtime_profile_version > 0),
  effective_manifest_hash TEXT NOT NULL,
  tool_set_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed','failed')),
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  evaluated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_service_runtime_evaluations_latest
  ON ai_service_runtime_evaluations(deployment_id, evaluated_at DESC);
