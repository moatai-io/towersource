-- 164: Indexes for Workbench Job claims and stale lease reconciliation.
-- Kept separate from ALTER TABLE migration 163 to avoid a combined lock-risk transaction.

CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_box_workbench_jobs_claim_token
  ON runtime_box_workbench_jobs(claim_token)
  WHERE claim_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_runtime_box_workbench_jobs_stale_lease
  ON runtime_box_workbench_jobs(status, lease_expires_at)
  WHERE status IN ('running', 'cancel_requested');
