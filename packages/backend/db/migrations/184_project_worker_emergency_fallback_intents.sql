-- Stale-safe approval intents for Project-level emergency return from Worker-first to Runtime Box compatibility.

CREATE TABLE IF NOT EXISTS project_worker_emergency_fallback_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_session_id TEXT NULL REFERENCES sessions(id) ON DELETE SET NULL,
  expected_binding JSONB NOT NULL,
  proposal_hash TEXT NOT NULL CHECK (proposal_hash ~ '^[0-9a-f]{64}$'),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed','succeeded','failed')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  result JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_project_worker_emergency_fallback_intents_active
  ON project_worker_emergency_fallback_intents(project_id,deployment_id,expires_at)
  WHERE consumed_at IS NULL;
