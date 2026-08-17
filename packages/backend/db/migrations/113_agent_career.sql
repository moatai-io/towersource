-- 113: Primary AI teammate career level and immutable promotion history.
ALTER TABLE project_agent_profiles
  ADD COLUMN IF NOT EXISTS career_level TEXT NOT NULL DEFAULT 'intern';

ALTER TABLE project_agent_profiles
  DROP CONSTRAINT IF EXISTS project_agent_profiles_career_level_check;
ALTER TABLE project_agent_profiles
  ADD CONSTRAINT project_agent_profiles_career_level_check
  CHECK (career_level IN ('intern', 'practitioner', 'manager', 'partner'));

CREATE TABLE IF NOT EXISTS project_agent_promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_level TEXT NOT NULL,
  to_level TEXT NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy_version TEXT NOT NULL DEFAULT 'tower-default-v1',
  promoted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, to_level)
);
