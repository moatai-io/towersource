-- 113: Pin the Project Primary Agent profile used by each Session.
-- Existing sessions remain NULL and are pinned lazily on their next Agent-first run.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS project_agent_profile_version INTEGER,
  ADD COLUMN IF NOT EXISTS project_agent_profile_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS project_agent_profile_source TEXT,
  ADD COLUMN IF NOT EXISTS project_agent_profile_pinned_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sessions_project_agent_profile_version
  ON sessions(project_id, project_agent_profile_version)
  WHERE project_agent_profile_version IS NOT NULL;
