-- 147: Append-only automation configuration revision ledger with direct change-intent provenance.

CREATE TABLE IF NOT EXISTS automation_config_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL CHECK (revision_no > 0),
  change_intent_id UUID REFERENCES automation_change_intents(id) ON DELETE RESTRICT,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  base_config_updated_at TIMESTAMPTZ NOT NULL,
  config_updated_at TIMESTAMPTZ NOT NULL,
  proposal_hash TEXT,
  materialized_updates JSONB NOT NULL,
  config_snapshot JSONB NOT NULL,
  mutation_source TEXT NOT NULL DEFAULT 'change_intent' CHECK (mutation_source IN ('change_intent','legacy_direct','system')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(automation_id, revision_no),
  UNIQUE(change_intent_id)
);

CREATE INDEX IF NOT EXISTS idx_automation_config_revisions_automation
  ON automation_config_revisions(automation_id, revision_no DESC);
