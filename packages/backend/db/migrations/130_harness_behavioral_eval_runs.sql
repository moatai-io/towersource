-- 130: Immutable behavioral eval reports and differential promotion decisions.

CREATE TABLE IF NOT EXISTS harness_behavioral_eval_runs (
  id TEXT PRIMARY KEY,
  harness_id TEXT NOT NULL,
  harness_version INTEGER NOT NULL CHECK (harness_version > 0),
  prompt_bundle_hash TEXT NOT NULL,
  eval_pack_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','passed','failed','error')),
  report JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY(harness_id,harness_version) REFERENCES harness_versions(harness_id,version) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_harness_behavioral_eval_runs_latest
  ON harness_behavioral_eval_runs(harness_id,harness_version,started_at DESC);

CREATE TABLE IF NOT EXISTS harness_eval_promotion_decisions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  harness_id TEXT NOT NULL,
  baseline_harness_version INTEGER NOT NULL CHECK (baseline_harness_version > 0),
  candidate_harness_version INTEGER NOT NULL CHECK (candidate_harness_version > 0),
  baseline_run_id TEXT NOT NULL REFERENCES harness_behavioral_eval_runs(id) ON DELETE RESTRICT,
  candidate_run_id TEXT NOT NULL REFERENCES harness_behavioral_eval_runs(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('promote','reject')),
  comparison JSONB NOT NULL,
  decided_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (baseline_run_id <> candidate_run_id),
  FOREIGN KEY(harness_id,baseline_harness_version) REFERENCES harness_versions(harness_id,version) ON DELETE RESTRICT,
  FOREIGN KEY(harness_id,candidate_harness_version) REFERENCES harness_versions(harness_id,version) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_harness_eval_promotion_decisions_latest
  ON harness_eval_promotion_decisions(harness_id,candidate_harness_version,decided_at DESC);
