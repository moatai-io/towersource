-- Team management approval receipts only, not membership/access authority.
-- No backfill or permission grants. Exact server preview is bound to one actor and expiry.
CREATE TABLE IF NOT EXISTS team_management_intents (
  id UUID PRIMARY KEY,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proposal_hash TEXT NOT NULL CHECK (proposal_hash ~ '^[0-9a-f]{64}$'),
  preview JSONB NOT NULL CHECK (jsonb_typeof(preview) = 'object'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((consumed_at IS NULL AND result IS NULL) OR (consumed_at IS NOT NULL AND result IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS team_management_intents_actor_created_idx
  ON team_management_intents(actor_user_id, created_at DESC);
-- Actor deletion discards their receipts, matching existing approval-intent conventions.
-- No team FK: create approval exists before the team, and this is not affiliation data.
