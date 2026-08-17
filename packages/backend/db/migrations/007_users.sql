-- ============================================================
-- 007: Users, Groups, User-Groups (from SQLite)
-- ============================================================

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_plain TEXT DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'member',
  disabled      INTEGER DEFAULT 0,
  allowed_path  TEXT DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Legacy compatibility shells. Product access control now uses project_members,
-- but older dist builds / rollback targets may still query these tables while
-- constructing runtime context. Keep them until a fleet-wide cleanup explicitly
-- verifies no stale runtime path can reference them.
CREATE TABLE groups (
  id          SERIAL PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL,
  description TEXT,
  is_global   INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE user_groups (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, group_id)
);
