-- 165: Support admin lifecycle lists after the lifecycle schema/backfill land.
CREATE INDEX IF NOT EXISTS idx_projects_lifecycle_status_updated
  ON projects (lifecycle_status, retired_at DESC);
