-- ============================================================
-- 001: Chat Rooms + Room Members
-- ============================================================

CREATE TABLE chat_rooms (
  id          TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::TEXT,
  name        TEXT NOT NULL,
  description TEXT,
  room_type   TEXT NOT NULL DEFAULT 'team',
  -- valid room_type: team, project, dashboard (app-level validation)
  project_id  TEXT,                        -- SQLite projects.id reference (cross-DB, no FK)
  avatar_url  TEXT,
  archived    INTEGER DEFAULT 0,
  created_by  INTEGER NOT NULL,            -- SQLite users.id reference
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_chat_rooms_type ON chat_rooms(room_type);

CREATE TABLE room_members (
  room_id      TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL,             -- SQLite users.id reference
  role         TEXT NOT NULL DEFAULT 'member',
  -- valid role: owner, admin, member, readonly (app-level validation)
  joined_at    TIMESTAMPTZ DEFAULT NOW(),
  last_read_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX idx_room_members_user ON room_members(user_id);
