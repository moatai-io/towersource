-- 125: Append-only Agent Harness binding revisions and rollback provenance.
CREATE TABLE IF NOT EXISTS agent_harness_binding_revisions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  harness_id TEXT NOT NULL,
  harness_version INTEGER NOT NULL,
  runtime_profile_id TEXT NOT NULL,
  runtime_profile_version INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','superseded','revoked')),
  previous_revision INTEGER,
  reason TEXT NOT NULL DEFAULT 'bind',
  command_id TEXT REFERENCES primary_agent_creation_commands(id) ON DELETE SET NULL,
  bound_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  bound_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,revision),
  FOREIGN KEY (harness_id,harness_version) REFERENCES harness_versions(harness_id,version) ON DELETE RESTRICT,
  FOREIGN KEY (runtime_profile_id,runtime_profile_version,harness_id,harness_version)
    REFERENCES harness_runtime_profile_versions(profile_id,profile_version,harness_id,harness_version) ON DELETE RESTRICT,
  FOREIGN KEY (project_id,previous_revision) REFERENCES agent_harness_binding_revisions(project_id,revision) ON DELETE RESTRICT
);
ALTER TABLE project_agent_harness_bindings ADD COLUMN IF NOT EXISTS current_revision INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_harness_one_active_revision ON agent_harness_binding_revisions(project_id) WHERE state='active';

INSERT INTO agent_harness_binding_revisions(project_id,revision,harness_id,harness_version,runtime_profile_id,runtime_profile_version,state,reason,bound_by_user_id,bound_at)
SELECT project_id,1,harness_id,harness_version,runtime_profile_id,runtime_profile_version,'active','backfill',bound_by_user_id,bound_at
FROM project_agent_harness_bindings
ON CONFLICT DO NOTHING;
UPDATE project_agent_harness_bindings SET current_revision=1 WHERE current_revision IS NULL;
ALTER TABLE project_agent_harness_bindings ALTER COLUMN current_revision SET NOT NULL;
ALTER TABLE project_agent_harness_bindings ADD CONSTRAINT project_agent_harness_current_revision_fkey
  FOREIGN KEY(project_id,current_revision) REFERENCES agent_harness_binding_revisions(project_id,revision) ON DELETE RESTRICT;
