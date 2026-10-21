-- 205a_webhook_connector_rename_repair.sql
-- Repair environments where migration 205 was recorded but the legacy generic
-- Connector table names remained. Keep this idempotent for correctly renamed DBs.

DO $$
BEGIN
  IF to_regclass('public.webhook_connectors') IS NULL
     AND to_regclass('public.connectors') IS NOT NULL THEN
    ALTER TABLE connectors RENAME TO webhook_connectors;
  END IF;

  IF to_regclass('public.webhook_events') IS NULL
     AND to_regclass('public.connector_events') IS NOT NULL THEN
    ALTER TABLE connector_events RENAME TO webhook_events;
  END IF;
END
$$;

ALTER TABLE IF EXISTS webhook_events
  ADD COLUMN IF NOT EXISTS normalized_event JSONB,
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS claim_id TEXT,
  ADD COLUMN IF NOT EXISTS claim_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
