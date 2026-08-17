-- 163: Primary Agent(Project) retirement lifecycle.
--
-- User-facing removal is reversible retirement. Permanent deletion is a
-- separate admin/operator purge workflow and must not reuse DELETE /projects.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retired_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS retirement_reason TEXT;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_lifecycle_status_chk;
ALTER TABLE projects ADD CONSTRAINT projects_lifecycle_status_chk CHECK (
  lifecycle_status IN ('active', 'retiring', 'retired', 'purge_pending', 'purge_failed')
);
