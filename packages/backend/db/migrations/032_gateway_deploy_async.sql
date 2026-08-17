-- Gateway async deploys
--
-- Long-running dynamic app builds (ACR → ACA, typically 3-8 minutes, sometimes
-- 10+) blow past nginx's proxy_read_timeout (60s default) even when the backend
-- succeeds. Customer curl gets a 504 while the deploy continues to completion
-- server-side — classic mismatch between client-visible outcome and real state.
--
-- Fix: let clients submit the job, get back a deploy_id immediately, and poll
-- a status endpoint. Reuse gateway_deploy_log as the single source of truth so
-- history, quota counting, and in-flight jobs all live in the same table.
--
-- Columns added:
--   status       — lifecycle: 'queued' → 'running' → 'success' | 'failed'.
--                  Existing rows default to 'complete' so legacy sync history
--                  reads as finished without touching anything else.
--   started_at   — wall-clock when the worker picked it up. Null while queued.
--                  Combined with created_at this also tells us queue latency.
--   phase        — informational sub-state for UI ('extracting' | 'building' |
--                  'deploying' | 'finalizing'). Nullable.

ALTER TABLE gateway_deploy_log
  ADD COLUMN IF NOT EXISTS status     TEXT NOT NULL DEFAULT 'complete',
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS phase      TEXT;

-- Partial index for the hot path: "give me jobs still in flight"
-- Size stays tiny (only queued/running rows), all historical rows excluded.
CREATE INDEX IF NOT EXISTS idx_gateway_deploy_log_status_inflight
  ON gateway_deploy_log (status, created_at)
  WHERE status IN ('queued', 'running');
