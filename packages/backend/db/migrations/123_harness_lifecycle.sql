-- 123: Harness draft -> validate -> publish lifecycle and immutable published Registry versions.

ALTER TABLE harness_versions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published';
ALTER TABLE harness_versions ADD COLUMN IF NOT EXISTS manifest_hash TEXT;
ALTER TABLE harness_versions ADD COLUMN IF NOT EXISTS effective_manifest JSONB;
ALTER TABLE harness_versions ADD COLUMN IF NOT EXISTS effective_manifest_hash TEXT;
ALTER TABLE harness_versions ADD COLUMN IF NOT EXISTS validation_run_id TEXT;
ALTER TABLE harness_versions ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

UPDATE harness_versions
   SET status = 'published',
       manifest_hash = COALESCE(manifest_hash, md5(manifest::text)),
       effective_manifest = COALESCE(effective_manifest, manifest),
       effective_manifest_hash = COALESCE(effective_manifest_hash, md5(COALESCE(effective_manifest, manifest)::text)),
       published_at = COALESCE(published_at, created_at)
 WHERE status = 'published';

CREATE TABLE IF NOT EXISTS harness_runtime_profile_versions (
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  harness_id TEXT NOT NULL,
  harness_version INTEGER NOT NULL,
  policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, profile_version, harness_id, harness_version),
  FOREIGN KEY (harness_id, harness_version) REFERENCES harness_versions(harness_id, version) ON DELETE RESTRICT
);

INSERT INTO harness_runtime_profile_versions(profile_id,profile_version,harness_id,harness_version,policy,policy_hash,status,created_at)
SELECT id,profile_version,harness_id,harness_version,policy,md5(policy::text),status,created_at
FROM harness_runtime_profiles
ON CONFLICT DO NOTHING;

ALTER TABLE project_agent_harness_bindings ADD COLUMN IF NOT EXISTS runtime_profile_version INTEGER;
UPDATE project_agent_harness_bindings b SET runtime_profile_version=p.profile_version
FROM harness_runtime_profiles p
WHERE b.runtime_profile_id=p.id AND b.harness_id=p.harness_id AND b.harness_version=p.harness_version AND b.runtime_profile_version IS NULL;
ALTER TABLE project_agent_harness_bindings ALTER COLUMN runtime_profile_version SET NOT NULL;
ALTER TABLE project_agent_harness_bindings DROP CONSTRAINT IF EXISTS project_agent_harness_bindings_runtime_profile_id_harness_id_harness_version_fkey;
ALTER TABLE project_agent_harness_bindings DROP CONSTRAINT IF EXISTS project_agent_harness_bindings_runtime_profile_fkey;
ALTER TABLE project_agent_harness_bindings ADD CONSTRAINT project_agent_harness_bindings_runtime_profile_version_fkey
  FOREIGN KEY (runtime_profile_id,runtime_profile_version,harness_id,harness_version)
  REFERENCES harness_runtime_profile_versions(profile_id,profile_version,harness_id,harness_version) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS harness_drafts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  harness_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  visibility TEXT NOT NULL DEFAULT 'project' CHECK (visibility IN ('project','private','system')),
  base_harness_id TEXT,
  base_harness_version INTEGER,
  manifest JSONB NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','validating','valid','invalid','published','abandoned')),
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_harness_id TEXT,
  published_version INTEGER
);

CREATE TABLE IF NOT EXISTS harness_validation_runs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  draft_id TEXT NOT NULL REFERENCES harness_drafts(id) ON DELETE CASCADE,
  draft_revision INTEGER NOT NULL,
  compiler_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('valid','invalid')),
  manifest_hash TEXT NOT NULL,
  effective_manifest JSONB,
  effective_manifest_hash TEXT,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE harness_versions
  DROP CONSTRAINT IF EXISTS harness_versions_validation_run_fkey;
ALTER TABLE harness_versions
  ADD CONSTRAINT harness_versions_validation_run_fkey
  FOREIGN KEY (validation_run_id) REFERENCES harness_validation_runs(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS harness_audit_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  harness_id TEXT,
  harness_version INTEGER,
  draft_id TEXT REFERENCES harness_drafts(id) ON DELETE SET NULL,
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_harness_drafts_owner_updated ON harness_drafts(owner_project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_harness_validation_draft ON harness_validation_runs(draft_id, draft_revision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_harness_audit_identity ON harness_audit_events(harness_id, harness_version, created_at DESC);

CREATE OR REPLACE FUNCTION harness_published_version_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'published' AND (
    NEW.harness_id IS DISTINCT FROM OLD.harness_id OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.engine IS DISTINCT FROM OLD.engine OR
    NEW.manifest IS DISTINCT FROM OLD.manifest OR
    NEW.manifest_hash IS DISTINCT FROM OLD.manifest_hash OR
    NEW.effective_manifest IS DISTINCT FROM OLD.effective_manifest OR
    NEW.effective_manifest_hash IS DISTINCT FROM OLD.effective_manifest_hash OR
    NEW.validation_run_id IS DISTINCT FROM OLD.validation_run_id OR
    NEW.published_at IS DISTINCT FROM OLD.published_at
  ) THEN
    RAISE EXCEPTION 'Published Harness versions are immutable';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_harness_published_version_immutable ON harness_versions;
CREATE TRIGGER trg_harness_published_version_immutable
BEFORE UPDATE ON harness_versions FOR EACH ROW EXECUTE FUNCTION harness_published_version_immutable();
