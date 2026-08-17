-- 135: Deduplicate repeated spawn_session side effects caused by transport retry
-- or automatic continuation replay.

ALTER TABLE spawn_callbacks
  ADD COLUMN IF NOT EXISTS request_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS root_turn_id TEXT,
  ADD COLUMN IF NOT EXISTS operation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_spawn_callbacks_request_fingerprint
  ON spawn_callbacks(parent_session_id, request_fingerprint, registered_at DESC)
  WHERE request_fingerprint IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_spawn_callbacks_operation_id
  ON spawn_callbacks(parent_session_id, operation_id)
  WHERE operation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_spawn_callbacks_root_turn
  ON spawn_callbacks(root_turn_id, registered_at DESC)
  WHERE root_turn_id IS NOT NULL;
