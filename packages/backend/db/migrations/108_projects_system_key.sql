-- 108: Stable identity for managed/system Projects.
-- Display names and filesystem paths may change; system_key is the routing and
-- idempotent seed key. Ordinary user-created projects keep NULL.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS system_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_system_key
  ON projects(system_key)
  WHERE system_key IS NOT NULL;
