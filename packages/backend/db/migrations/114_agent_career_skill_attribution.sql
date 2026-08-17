-- 114: Career-only attribution for Skills created by a Project's Primary AI teammate.
CREATE TABLE IF NOT EXISTS project_agent_skill_attributions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  skill_path TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  evidence_type TEXT NOT NULL DEFAULT 'runtime-created',
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  attributed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, skill_name)
);

CREATE INDEX IF NOT EXISTS idx_project_agent_skill_attributions_active
  ON project_agent_skill_attributions(project_id, status);
