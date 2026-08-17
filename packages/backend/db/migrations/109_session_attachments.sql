-- 109: User-owned, session-scoped chat attachments with explicit promotion.
CREATE TABLE IF NOT EXISTS session_attachments (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,
  original_name     TEXT NOT NULL,
  storage_path      TEXT NOT NULL UNIQUE,
  mime_type         TEXT,
  size_bytes        BIGINT NOT NULL,
  content_sha256    TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'temporary'
                    CHECK (status IN ('temporary', 'promoted_personal', 'promoted_project', 'deleted')),
  promoted_uri      TEXT,
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  last_accessed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_attachments_owner_session
  ON session_attachments(owner_user_id, session_id, created_at DESC)
  WHERE status <> 'deleted';

CREATE INDEX IF NOT EXISTS idx_session_attachments_expiry
  ON session_attachments(expires_at)
  WHERE status = 'temporary';
