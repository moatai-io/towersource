-- Explicit Project execution authority tier.
-- This is policy metadata only; Worker capability/root configuration must independently
-- match the selected mode before execution can gain broader filesystem access.

ALTER TABLE project_compute_settings
  ADD COLUMN IF NOT EXISTS authority_mode TEXT NOT NULL DEFAULT 'project';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'project_compute_settings_authority_mode_chk'
  ) THEN
    ALTER TABLE project_compute_settings
      ADD CONSTRAINT project_compute_settings_authority_mode_chk
      CHECK (authority_mode IN ('project', 'operator-plane', 'sandbox'));
  END IF;
END $$;

COMMENT ON COLUMN project_compute_settings.authority_mode IS
  'project=harness/project root; operator-plane=explicit trusted developer plane access; sandbox=strong isolation executor';
