-- 070_skill_registry_visibility_copy.sql
-- Skill Registry simplified visibility + public copy/fork metadata.
-- Decision: workspace/decisions/2026-05-26-skill-registry-simplified-visibility-and-orchestration.md

ALTER TABLE skill_registry
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';

ALTER TABLE skill_registry DROP CONSTRAINT IF EXISTS skill_registry_visibility_chk;
ALTER TABLE skill_registry ADD CONSTRAINT skill_registry_visibility_chk CHECK (
  visibility IN ('private', 'public', 'default', 'hidden')
);

ALTER TABLE skill_registry
  ADD COLUMN IF NOT EXISTS source_skill_id TEXT,
  ADD COLUMN IF NOT EXISTS source_skill_name TEXT,
  ADD COLUMN IF NOT EXISTS source_catalog TEXT,
  ADD COLUMN IF NOT EXISTS source_snapshot_hash TEXT,
  ADD COLUMN IF NOT EXISTS copied_from JSONB DEFAULT '{}'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS runtime_requirements JSONB DEFAULT '{}'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS portability JSONB DEFAULT '{}'::jsonb NOT NULL;

CREATE INDEX IF NOT EXISTS idx_skill_registry_visibility
  ON skill_registry (visibility);

CREATE INDEX IF NOT EXISTS idx_skill_registry_source_skill
  ON skill_registry (source_skill_id)
  WHERE source_skill_id IS NOT NULL;

COMMENT ON COLUMN skill_registry.visibility IS
  'Skill Registry visibility: private owner-only, public searchable/copyable, default prompt candidate, hidden excluded.';
COMMENT ON COLUMN skill_registry.source_snapshot_hash IS
  'sha256 of source skill content at copy time. Copy remains independent after source visibility changes.';
