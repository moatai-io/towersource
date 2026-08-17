-- ============================================================
-- 008: Sessions, Messages (from SQLite)
-- ============================================================

CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,
  claude_session_id TEXT,
  name              TEXT NOT NULL,
  cwd               TEXT,
  tags              TEXT DEFAULT '[]',
  favorite          INTEGER DEFAULT 0,
  user_id           INTEGER REFERENCES users(id),
  total_cost        REAL DEFAULT 0,
  total_tokens      INTEGER DEFAULT 0,
  model_used        TEXT,
  auto_named        INTEGER DEFAULT 1,
  summary           TEXT,
  summary_at_turn   INTEGER,
  turn_count        INTEGER DEFAULT 0,
  files_edited      TEXT DEFAULT '[]',
  archived          INTEGER DEFAULT 0,
  engine            TEXT DEFAULT 'claude',
  visibility        TEXT DEFAULT 'private',
  room_id           TEXT,
  project_id        TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_sessions_claude_sid
  ON sessions(claude_session_id) WHERE claude_session_id IS NOT NULL;
CREATE INDEX idx_sessions_project ON sessions(project_id);
CREATE INDEX idx_sessions_room ON sessions(room_id) WHERE room_id IS NOT NULL;
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE messages (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role              TEXT NOT NULL,
  content           TEXT NOT NULL,
  parent_tool_use_id TEXT,
  duration_ms       INTEGER,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_session ON messages(session_id, created_at);
