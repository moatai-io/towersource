-- 208: Add queue indexes after webhook event schema and status normalization.

CREATE INDEX IF NOT EXISTS idx_webhook_events_dispatch_queue
  ON webhook_events(next_attempt_at, received_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_webhook_events_expired_claims
  ON webhook_events(claim_until)
  WHERE status = 'dispatching';
