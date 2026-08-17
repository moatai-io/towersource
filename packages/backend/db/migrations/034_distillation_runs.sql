-- distillation_runs — telemetry for the AI-native PM distiller
--
-- See decisions:
--   workspace/decisions/2026-04-24-ai-native-pm-plan.md (success criteria)
--   workspace/decisions/2026-04-24-ai-native-pm-d5-dedup-strategy.md (skip layers)
--   docs/plans/ai-native-pm/distiller-prompt-v1.md (field origins)
--
-- Purpose: every distiller invocation gets a row here, including skipped
-- and failed attempts. This is the canonical record of "did we try to
-- distill session X for kind Y?" — knowledge_candidates only sees
-- successful runs that produced ≥1 surviving candidate.
--
-- Design intent (P5 — short feedback loops):
--   The whole alpha rests on "haeboomyeon neukkinda" — see by doing. That
--   only works if the counters exist from day 1. Without this table we
--   cannot answer:
--     - What's our accept rate? (join to knowledge_candidates.review_status)
--     - What's our re-propose rate? (count rejected hashes that re-appeared)
--     - Where does dedup fail? (skip_reason_counts breakdown)
--     - Are we burning tokens on noise? (cost_usd per accepted candidate)
--
-- Status field semantics:
--   success — LLM ran, output parsed, ≥0 candidates emitted (0 is fine, just means "nothing worth flagging")
--   failed  — LLM error, parse error, or post-processing exception. error column populated.
--   skipped — Layer 1/2/3 prevented the LLM call entirely. skip_reason populated, no token cost.
--
-- Rollback:
--   DROP TABLE IF EXISTS distillation_runs;

CREATE TABLE IF NOT EXISTS distillation_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The session being distilled. Same shape as knowledge_candidates.source_session.
  -- Not FK'd to sessions for the same reason (decoupling from session lifecycle).
  session_id      TEXT NOT NULL,

  -- Which extractor ran. issue-extractor (Phase 1), decision-extractor (Phase 2), etc.
  -- Mirrors the kind enum in knowledge_nodes/candidates so a JOIN is meaningful.
  kind            TEXT NOT NULL
                  CHECK (kind IN ('issue', 'decision', 'assumption')),

  -- ── Versioning ─────────────────────────────────────────────────
  -- Free text for alpha — we intentionally don't FK to a versions table
  -- yet. When we have >3 prompt versions in flight we'll formalize.

  prompt_version  TEXT NOT NULL,
  model_version   TEXT NOT NULL,

  -- ── Performance ────────────────────────────────────────────────

  input_tokens    INTEGER,
  output_tokens   INTEGER,
  latency_ms      INTEGER,

  -- Computed at write time using the model's published rate. Stored rather
  -- than recomputed at query time so retroactive rate changes don't shift
  -- historical numbers.
  cost_usd        NUMERIC(10, 6),

  -- ── Output / dedup outcome ─────────────────────────────────────

  -- Raw count of items the LLM emitted before any dedup filter.
  candidates_emitted        INTEGER NOT NULL DEFAULT 0,

  -- Count after D5 Layer 2 (range overlap) + Layer 3 (hash reject) filtering.
  -- Always ≤ candidates_emitted. The diff = how many got dropped by dedup.
  candidates_after_dedup    INTEGER NOT NULL DEFAULT 0,

  -- Per-layer drop counts. Shape: { range_overlap: 0, hash_rejected: 0 }
  -- Layer 1 (session_gate) prevents the run from happening, so its count
  -- here will always be 0 — see top-level skip_reason instead.
  skip_reason_counts        JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- ── Lifecycle ──────────────────────────────────────────────────

  status          TEXT NOT NULL
                  CHECK (status IN ('success', 'failed', 'skipped')),

  -- Populated when status='failed'. LLM error, parse error, etc.
  error           TEXT,

  -- Populated when status='skipped'. Values match Layer names:
  --   'session_gate'    — D5 Layer 1: this (session, kind) already distilled
  --   'tail_truncated'  — input too long, distillation deferred
  --   'feature_disabled' — AI_PM_ENABLED=false at trigger time
  skip_reason     TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Sanity: a run can't be both successful AND have an error message.
  CONSTRAINT distillation_runs_consistent CHECK (
    (status = 'success' AND error IS NULL AND skip_reason IS NULL)
    OR
    (status = 'failed'  AND error IS NOT NULL AND skip_reason IS NULL)
    OR
    (status = 'skipped' AND error IS NULL AND skip_reason IS NOT NULL)
  )
);

-- D5 Layer 1 hot path: "has (session, kind) already been distilled?"
-- This is THE check the distiller runs before doing anything else.
-- Includes successful AND failed runs — a failed run still counts as
-- "we tried" so we don't retry forever. Skipped runs don't count
-- (they're cheap to redo, and skipping was external).
CREATE INDEX IF NOT EXISTS idx_distillation_runs_session_kind
  ON distillation_runs (session_id, kind, created_at DESC)
  WHERE status IN ('success', 'failed');

-- Dashboard queries: timeseries of runs.
CREATE INDEX IF NOT EXISTS idx_distillation_runs_created
  ON distillation_runs (created_at DESC);

-- Failure triage: "show me recent failures"
CREATE INDEX IF NOT EXISTS idx_distillation_runs_failed
  ON distillation_runs (created_at DESC)
  WHERE status = 'failed';
