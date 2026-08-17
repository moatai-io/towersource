-- 107: Project = Primary Agent Workcell profile
--
-- A Project remains the identity/ACL/filesystem anchor. This 1:1 profile stores
-- the user-facing primary-agent identity and runtime policy without duplicating
-- the Project entity. Existing projects derive an implicit profile when no row
-- exists, so this migration is additive and requires no bulk backfill.

CREATE TABLE IF NOT EXISTS project_agent_profiles (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,

  display_name TEXT,
  face TEXT,
  tagline TEXT,
  role TEXT,
  promise TEXT,

  instruction TEXT,
  instruction_version INTEGER NOT NULL DEFAULT 1,
  instruction_source TEXT NOT NULL DEFAULT 'agents-md',

  default_engine TEXT,
  default_model TEXT,

  authority_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  tool_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  memory_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  budget_policy JSONB NOT NULL DEFAULT '{}'::jsonb,

  status TEXT NOT NULL DEFAULT 'active',
  onboarding_state TEXT NOT NULL DEFAULT 'ready',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_agent_profiles_status_updated
  ON project_agent_profiles(status, updated_at DESC);
