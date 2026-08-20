-- Add server-issued smoke receipt evidence to Workstation change intents already created by migration 188.

ALTER TABLE project_workstation_change_intents
  ADD COLUMN IF NOT EXISTS smoke_receipt_hash TEXT NULL,
  ADD COLUMN IF NOT EXISTS smoke_verified_at TIMESTAMPTZ NULL;

ALTER TABLE project_workstation_change_intents
  DROP CONSTRAINT IF EXISTS project_workstation_change_intents_smoke_receipt_hash_check;

ALTER TABLE project_workstation_change_intents
  ADD CONSTRAINT project_workstation_change_intents_smoke_receipt_hash_check
  CHECK (smoke_receipt_hash IS NULL OR smoke_receipt_hash ~ '^[0-9a-f]{64}$');
