-- Stale-safe approval intents for changing one Project deployment's sticky Workstation binding.

CREATE TABLE IF NOT EXISTS project_workstation_change_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL,
  target_worker_id TEXT NOT NULL REFERENCES runtime_box_workbench_workers(worker_id) ON DELETE CASCADE,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_session_id TEXT NULL REFERENCES sessions(id) ON DELETE SET NULL,
  expected_binding JSONB NULL,
  target_snapshot JSONB NOT NULL,
  proposal_hash TEXT NOT NULL CHECK (proposal_hash ~ '^[0-9a-f]{64}$'),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed','succeeded','failed')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  smoke_receipt_hash TEXT NULL CHECK (smoke_receipt_hash IS NULL OR smoke_receipt_hash ~ '^[0-9a-f]{64}$'),
  smoke_verified_at TIMESTAMPTZ NULL,
  result JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_project_workstation_change_intents_active
  ON project_workstation_change_intents(project_id,deployment_id,expires_at)
  WHERE consumed_at IS NULL;
