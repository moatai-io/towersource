-- 105: Short authenticated workspace file links (/f/:shortId)
CREATE TABLE IF NOT EXISTS file_links (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  short_id         TEXT NOT NULL UNIQUE,
  file_path        TEXT NOT NULL,
  owner_id         INTEGER NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_file_links_short_id ON file_links(short_id);
CREATE INDEX IF NOT EXISTS idx_file_links_owner_path ON file_links(owner_id, file_path);
