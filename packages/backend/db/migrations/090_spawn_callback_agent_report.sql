-- 090: Persist compact Agent Report metadata for restored spawn callbacks.
--
-- Persistent Agent Sessions use spawn_callbacks as the callback backup while a
-- backing subagent session is running. If the backend restarts before the child
-- finishes, the callback must still know this is an agent report so the parent
-- receives only the compact summary/report card, not the full child answer.

ALTER TABLE spawn_callbacks
  ADD COLUMN IF NOT EXISTS agent_report JSONB;
