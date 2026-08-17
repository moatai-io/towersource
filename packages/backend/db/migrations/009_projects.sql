-- ============================================================
-- 009: Projects, Project Members (from SQLite)
-- ============================================================

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  root_path   TEXT,
  color       TEXT DEFAULT '#f59e0b',
  sort_order  INTEGER DEFAULT 0,
  collapsed   INTEGER DEFAULT 0,
  archived    INTEGER DEFAULT 0,
  user_id     INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member',
  added_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX idx_pm_user ON project_members(user_id);

-- Add FK from sessions to projects (sessions already created in 008)
-- Using soft reference — no ALTER needed since project_id is TEXT without FK constraint in sessions
