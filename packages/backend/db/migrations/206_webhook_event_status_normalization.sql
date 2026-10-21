-- 206: Normalize legacy webhook event status values before constraint finalization.

UPDATE webhook_events SET status = 'queued' WHERE status = 'accepted';
