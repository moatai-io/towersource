-- 132: Make Prompt Bundle identity explicit in AI Service runtime evaluations.
-- Existing rows predate Prompt Component fingerprints and remain non-activatable
-- until a fresh Preview writes the current bundle hash.

ALTER TABLE ai_service_runtime_evaluations
  ADD COLUMN IF NOT EXISTS prompt_bundle_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_service_runtime_evaluations_prompt_bundle
  ON ai_service_runtime_evaluations(deployment_id,prompt_bundle_hash,evaluated_at DESC)
  WHERE prompt_bundle_hash IS NOT NULL;
