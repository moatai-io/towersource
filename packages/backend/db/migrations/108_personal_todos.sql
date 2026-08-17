-- 108: User-owned structured My Todo items, separate from notes and projects.
CREATE TABLE IF NOT EXISTS personal_todos (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  note            TEXT,
  completed_at    TIMESTAMPTZ,
  archived_at     TIMESTAMPTZ,
  source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  sort_order      BIGINT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_personal_todos_owner_active
  ON personal_todos(owner_user_id, completed_at NULLS FIRST, sort_order, created_at DESC)
  WHERE archived_at IS NULL;
