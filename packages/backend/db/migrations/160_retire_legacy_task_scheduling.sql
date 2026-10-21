-- Retire tasks.schedule_* and the pre-Automation schedules registry.
-- Task rows remain as durable work history. Legacy schedule rows and their run
-- history are preserved as JSON before removal from the active tables.

CREATE TABLE IF NOT EXISTS legacy_schedule_archive (
  schedule_id TEXT PRIMARY KEY,
  schedule_snapshot JSONB NOT NULL,
  run_snapshots JSONB NOT NULL DEFAULT '[]'::jsonb,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archive_reason TEXT NOT NULL DEFAULT 'automation_registry_cutover'
);

INSERT INTO legacy_schedule_archive (schedule_id, schedule_snapshot, run_snapshots)
SELECT
  s.id,
  to_jsonb(s),
  COALESCE((
    SELECT jsonb_agg(to_jsonb(sr) ORDER BY sr.ran_at)
    FROM schedule_runs sr
    WHERE sr.schedule_id = s.id
  ), '[]'::jsonb)
FROM schedules s
ON CONFLICT (schedule_id) DO NOTHING;

-- The old schedules registry is disabled by default and has been superseded by
-- automations. Remove archived rows from the active registry after preserving
-- both configuration and run history above.
DELETE FROM schedules;

-- Legacy task scheduling is no longer executable. Preserve task content and
-- provenance, but normalize every historical scheduling flag to disabled.
UPDATE tasks
SET schedule_enabled = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE schedule_enabled IS DISTINCT FROM 0;

-- Any task carrying legacy scheduling metadata is historical after cutover.
-- Keep the row and its schedule fields for audit/rollback, but hide it from the
-- active Task board.
UPDATE tasks
SET archived = 1,
    updated_at = CURRENT_TIMESTAMP
WHERE scheduled_at IS NOT NULL
   OR schedule_cron IS NOT NULL;
