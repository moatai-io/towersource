-- 116: Audit user-initiated Finder uploads and downloads without storing file contents.
CREATE TABLE IF NOT EXISTS file_transfer_events (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('upload', 'download')),
  transfer_kind TEXT NOT NULL CHECK (transfer_kind IN ('single', 'selection', 'folder', 'multipart', 'resumable')),
  status        TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('started', 'completed', 'failed', 'denied')),
  item_count    INTEGER NOT NULL DEFAULT 1 CHECK (item_count >= 0),
  total_bytes   BIGINT,
  paths         JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_file_transfer_events_project_time
  ON file_transfer_events(project_id, created_at DESC)
  WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_file_transfer_events_actor_time
  ON file_transfer_events(actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

COMMENT ON TABLE file_transfer_events IS
  'Audit trail for authenticated Finder uploads/downloads. Stores actor, project, path metadata, counts and sizes; never file contents.';
