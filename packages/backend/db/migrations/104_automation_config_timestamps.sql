-- 104: Separate automation configuration timestamps from runtime activity.
--
-- `automations.updated_at` is a technical row timestamp and was historically
-- also bumped by scheduled runs. Product views need a stable "created/edited"
-- ordering that is not affected by normal execution, so keep config changes in
-- `config_updated_at`, run recency in `last_run_at`/automation_runs, and
-- mutable runner checkpoints in `runtime_state_json`.

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS config_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS config_updated_by_user_id INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS runtime_state_json JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE automations
SET config_updated_at = COALESCE(config_updated_at, updated_at, created_at, NOW())
WHERE config_updated_at IS NULL;

ALTER TABLE automations
  ALTER COLUMN config_updated_at SET DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_automations_config_updated
  ON automations(config_updated_at DESC)
  WHERE status != 'archived';

CREATE INDEX IF NOT EXISTS idx_automations_project_config_updated
  ON automations(project_id, config_updated_at DESC)
  WHERE project_id IS NOT NULL AND status != 'archived';

CREATE INDEX IF NOT EXISTS idx_automations_last_run
  ON automations(last_run_at DESC)
  WHERE last_run_at IS NOT NULL AND status != 'archived';
