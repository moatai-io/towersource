-- 207: Finalize the normalized webhook event status constraint.

ALTER TABLE webhook_events DROP CONSTRAINT IF EXISTS connector_events_status_check;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_status_check
  CHECK (status IN ('queued', 'dispatching', 'ignored', 'task_created', 'failed', 'needs_review'));
