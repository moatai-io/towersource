-- 160: One-time approval intents for safe cleanup of orphaned Workbench mutation candidates.

CREATE TABLE IF NOT EXISTS runtime_box_workbench_recovery_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  command_id UUID NOT NULL REFERENCES runtime_box_workbench_tool_commands(id) ON DELETE RESTRICT,
  actor_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  actor_role TEXT NOT NULL,
  expected_revision INTEGER,
  expected_command_status TEXT NOT NULL CHECK (expected_command_status IN ('reserved','running')),
  action_kind TEXT NOT NULL CHECK (action_kind IN ('cleanup-orphan-candidate')),
  inspection_snapshot JSONB NOT NULL,
  proposal_hash TEXT NOT NULL CHECK (proposal_hash ~ '^[0-9a-f]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'previewed'
    CHECK (status IN ('previewed','applying','succeeded','failed','recovery_required')),
  failure_code TEXT,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_workbench_recovery_intents_project_recent
  ON runtime_box_workbench_recovery_intents(project_id, created_at DESC);

COMMENT ON TABLE runtime_box_workbench_recovery_intents IS
  'Short-lived, one-time approvals for deleting only a command-scoped orphan staging candidate after exact Workbench state revalidation.';
