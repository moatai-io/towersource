-- Per-session reasoning override. NULL follows the selected model's current VM default.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS reasoning_effort TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sessions_reasoning_effort_check'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_reasoning_effort_check
      CHECK (reasoning_effort IS NULL OR reasoning_effort IN ('low', 'medium', 'high', 'xhigh', 'max'));
  END IF;
END $$;
