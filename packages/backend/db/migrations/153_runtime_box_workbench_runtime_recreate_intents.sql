-- 153: One-time, stale-safe operator intents for explicit managed Workbench Runtime recreation.

CREATE TABLE IF NOT EXISTS runtime_box_workbench_runtime_recreate_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  box_id BIGINT NOT NULL REFERENCES project_runtime_boxes(id) ON DELETE CASCADE,
  actor_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  actor_role TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK (current_revision > 0),
  mounted_revision INTEGER NOT NULL CHECK (mounted_revision > 0),
  target_revision INTEGER NOT NULL CHECK (target_revision > 0),
  container_id TEXT NOT NULL,
  service_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  activity_snapshot JSONB NOT NULL,
  runtime_snapshot JSONB NOT NULL,
  proposal_hash TEXT NOT NULL CHECK (proposal_hash ~ '^[0-9a-f]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'previewed'
    CHECK (status IN ('previewed','applying','succeeded','failed','recovery_required')),
  stage TEXT NOT NULL DEFAULT 'previewed',
  failure_code TEXT,
  audit_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_workbench_runtime_recreate_intents_project_recent
  ON runtime_box_workbench_runtime_recreate_intents(project_id, created_at DESC);

COMMENT ON TABLE runtime_box_workbench_runtime_recreate_intents IS
  'Short-lived, one-time operator approval intents for stopping exactly one stale Runtime container and recreating it on the current finalized managed Workbench revision.';
