-- 151: Restart-safe approval intents and idempotent commands for managed Workbench tool mutations.

CREATE TABLE IF NOT EXISTS runtime_box_workbench_tool_change_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  actor_role TEXT NOT NULL,
  expected_revision INTEGER,
  action JSONB NOT NULL,
  reason TEXT NOT NULL,
  proposal_hash TEXT NOT NULL CHECK (proposal_hash ~ '^[0-9a-f]{64}$'),
  risk TEXT NOT NULL DEFAULT 'medium' CHECK (risk IN ('medium','high')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_by_command_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS runtime_box_workbench_tool_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id UUID NOT NULL REFERENCES runtime_box_workbench_tool_change_intents(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  action_kind TEXT NOT NULL CHECK (action_kind IN ('install','rollback')),
  expected_revision INTEGER,
  before_revision INTEGER,
  after_revision INTEGER,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','running','succeeded','failed','recovery_required')),
  result JSONB,
  error_code TEXT,
  error_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE(actor_user_id, idempotency_key)
);

ALTER TABLE runtime_box_workbench_tool_change_intents
  ADD CONSTRAINT runtime_box_workbench_tool_intent_command_fkey
  FOREIGN KEY(consumed_by_command_id)
  REFERENCES runtime_box_workbench_tool_commands(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_runtime_box_workbench_tool_intents_project_recent
  ON runtime_box_workbench_tool_change_intents(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_box_workbench_tool_commands_project_recent
  ON runtime_box_workbench_tool_commands(project_id, created_at DESC);
