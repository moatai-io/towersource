-- 106: User-owned personal Markdown files, separate from project workspaces.
CREATE TABLE IF NOT EXISTS personal_files (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relative_path   TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'file')),
  mime_type       TEXT,
  size_bytes      BIGINT NOT NULL DEFAULT 0,
  content_sha256  TEXT NOT NULL DEFAULT '',
  version         BIGINT NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_files_owner_path_active
  ON personal_files(owner_user_id, relative_path)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_personal_files_owner_updated
  ON personal_files(owner_user_id, updated_at DESC)
  WHERE deleted_at IS NULL;
