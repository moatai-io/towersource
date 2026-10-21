-- 205: Narrow generic Connector naming to Webhook Connector and split public
-- Ingress admission from internal dispatch execution.
-- 202-204 are reserved by concurrent session work in the shared tree.

ALTER TABLE IF EXISTS connectors RENAME TO webhook_connectors;
ALTER TABLE IF EXISTS connector_events RENAME TO webhook_events;

ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS normalized_event JSONB,
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS claim_id TEXT,
  ADD COLUMN IF NOT EXISTS claim_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;

