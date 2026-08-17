-- 040_pm_inbox.sql — D12 Phase 1: Inbox of decision questions.
--
-- Each row is a question the AI poses to the user, with explicit choices.
-- Auto-derived (new_candidate, dormant_issue, due_soon, stale_agents_md,
-- attribution_check) cards upsert by `fingerprint` to avoid duplicates across
-- re-derives. User-seeded cards (`user_seed`) get a new fingerprint per insert.
--
-- stale_agents_md replaces Heartbeat L1 polling — see
-- workspace/decisions/2026-04-28-heartbeat-deprecation.md.
--
-- Lifecycle:
--   pending → answered (answer recorded, action executed) — disappears from inbox
--           → dismissed (just hide it) — disappears from inbox
--
-- 'open' = dismissed_at IS NULL AND answered_at IS NULL.

CREATE TABLE IF NOT EXISTS pm_inbox_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL,
  fingerprint TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,                  -- new_candidate | dormant_issue | due_soon | stale_agents_md | attribution_check | conflict_decision | user_seed
  question TEXT NOT NULL,
  choices JSONB NOT NULL DEFAULT '[]'::jsonb,
  context JSONB DEFAULT '{}'::jsonb,
  source_ref TEXT,                      -- candidate_id / issue_id / etc
  priority INTEGER DEFAULT 0,           -- higher = more urgent
  created_at TIMESTAMPTZ DEFAULT NOW(),
  dismissed_at TIMESTAMPTZ,
  answered_at TIMESTAMPTZ,
  answer JSONB
);

CREATE INDEX IF NOT EXISTS idx_pm_inbox_open
  ON pm_inbox_items(user_id, priority DESC, created_at DESC)
  WHERE dismissed_at IS NULL AND answered_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pm_inbox_kind ON pm_inbox_items(kind);

COMMENT ON TABLE pm_inbox_items IS
  'D12 — Inbox of decision questions. fingerprint dedups auto-derived cards.';

-- ── 041_pm_weekly_reports.sql will land alongside (split for clarity) ──
