-- New turns distinguish a Tower-managed model preset from workload/reasoning policy.
-- Existing rows and session model choices are intentionally left untouched.
ALTER TABLE ai_usage_events
  ADD COLUMN IF NOT EXISTS selected_preset TEXT
    CHECK (selected_preset IN ('core', 'lite')),
  ADD COLUMN IF NOT EXISTS preset_mapping_revision INTEGER
    CHECK (preset_mapping_revision > 0);
