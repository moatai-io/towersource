-- ============================================================
-- 048: Severity tier on schedules + automations
--
-- 4-tier severity model for AI → user signals (Tower channel):
--   L1 silent — no channel post (audit only)
--   L2 digest — short channel post, no mention
--   L3 inbox  — channel post + Board issue link (Phase 3)
--   L4 push   — channel post + @mention + OS push (Phase 3)
--
-- Default L2 means "post a one-liner to Tower channel" — safe baseline that
-- preserves visibility for existing schedules without spamming. Owners can
-- bump to L1 (silence) or up to L3/L4 as they tune.
--
-- See: workspace/decisions/2026-05-04-tower-channel-and-persona.md
--      tower/docs/plans/2026-05-04-tower-channel-implementation.md
-- ============================================================

ALTER TABLE schedules
  ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'L2';

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'L2';

-- App-level validation: severity ∈ {'L1','L2','L3','L4'}.
-- Not enforced as CHECK constraint to keep migration cheap and to allow future
-- tier additions without a constraint rebuild on a large table.
