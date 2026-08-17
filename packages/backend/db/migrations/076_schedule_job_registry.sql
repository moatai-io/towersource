-- 076: Generalize automations into the user-facing Schedule job registry.

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS job_type TEXT NOT NULL DEFAULT 'ai_prompt',
  ADD COLUMN IF NOT EXISTS scope_type TEXT NOT NULL DEFAULT 'project',
  ADD COLUMN IF NOT EXISTS definition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS risk_level TEXT NOT NULL DEFAULT 'low',
  ADD COLUMN IF NOT EXISTS timeout_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Asia/Seoul',
  ADD COLUMN IF NOT EXISTS created_by_session_id TEXT,
  ADD COLUMN IF NOT EXISTS updated_by_user_id INTEGER;

UPDATE automations
SET
  job_type = COALESCE(job_type, 'ai_prompt'),
  scope_type = CASE WHEN project_id IS NULL THEN 'system' ELSE 'project' END,
  definition_json = CASE
    WHEN COALESCE(definition_json, '{}'::jsonb) = '{}'::jsonb THEN jsonb_build_object(
      'prompt', COALESCE(prompt, ''),
      'mode', COALESCE(mode, 'spawn'),
      'targetId', target_id,
      'model', model,
      'workflow', workflow,
      'cwd', cwd
    )
    ELSE definition_json
  END
WHERE job_type = 'ai_prompt';

CREATE INDEX IF NOT EXISTS idx_automations_job_type ON automations(job_type);
CREATE INDEX IF NOT EXISTS idx_automations_scope_type ON automations(scope_type);
CREATE INDEX IF NOT EXISTS idx_automations_project_type ON automations(project_id, job_type)
  WHERE status != 'archived';

ALTER TABLE automation_runs
  ADD COLUMN IF NOT EXISTS trigger TEXT NOT NULL DEFAULT 'schedule',
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stdout_text TEXT,
  ADD COLUMN IF NOT EXISTS stderr_text TEXT,
  ADD COLUMN IF NOT EXISTS summary_text TEXT,
  ADD COLUMN IF NOT EXISTS error_json JSONB,
  ADD COLUMN IF NOT EXISTS runner_kind TEXT,
  ADD COLUMN IF NOT EXISTS runner_ref TEXT;

UPDATE automation_runs
SET
  started_at = COALESCE(started_at, ran_at),
  finished_at = COALESCE(finished_at, ran_at),
  runner_kind = COALESCE(runner_kind, CASE WHEN mode IN ('spawn', 'inject', 'channel') THEN 'ai' ELSE 'system' END),
  summary_text = COALESCE(summary_text, error);
