-- ============================================================
-- 010: Tasks, Pins, Scripts, Git Commits, Shares,
--      System Prompts, Skill Registry, User Skill Prefs
-- ============================================================

-- Tasks (kanban)
CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  description      TEXT DEFAULT '',
  cwd              TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'todo',
  session_id       TEXT,
  sort_order       INTEGER DEFAULT 0,
  progress_summary TEXT DEFAULT '[]',
  model            TEXT DEFAULT 'claude-opus-4-6',
  archived         INTEGER DEFAULT 0,
  scheduled_at     TEXT,
  schedule_cron    TEXT,
  schedule_enabled INTEGER DEFAULT 0,
  workflow         TEXT DEFAULT 'auto',
  parent_task_id   TEXT,
  worktree_path    TEXT,
  project_id       TEXT REFERENCES projects(id),
  room_id          TEXT,
  triggered_by     INTEGER,
  room_message_id  TEXT,
  user_id          INTEGER REFERENCES users(id),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  completed_at     TIMESTAMPTZ
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_user ON tasks(user_id);
CREATE INDEX idx_tasks_schedule ON tasks(schedule_enabled, scheduled_at)
  WHERE schedule_enabled = 1;
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id)
  WHERE parent_task_id IS NOT NULL;
CREATE INDEX idx_tasks_room ON tasks(room_id)
  WHERE room_id IS NOT NULL;

-- Pins
CREATE TABLE pins (
  id         SERIAL PRIMARY KEY,
  title      TEXT NOT NULL,
  file_path  TEXT NOT NULL,
  file_type  TEXT NOT NULL DEFAULT 'markdown',
  pin_type   TEXT NOT NULL DEFAULT 'file',
  content    TEXT,
  sort_order INTEGER DEFAULT 0,
  user_id    INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Scripts
CREATE TABLE scripts (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  code       TEXT NOT NULL,
  language   TEXT DEFAULT 'python',
  session_id TEXT,
  user_id    INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Git Commits
CREATE TABLE git_commits (
  id            SERIAL PRIMARY KEY,
  hash          TEXT NOT NULL UNIQUE,
  short_hash    TEXT NOT NULL,
  author_name   TEXT NOT NULL,
  message       TEXT NOT NULL,
  commit_type   TEXT DEFAULT 'auto',
  session_id    TEXT,
  user_id       INTEGER,
  files_changed TEXT DEFAULT '[]',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Shares
CREATE TABLE shares (
  id             TEXT PRIMARY KEY,
  file_path      TEXT NOT NULL,
  owner_id       INTEGER NOT NULL REFERENCES users(id),
  share_type     TEXT NOT NULL CHECK(share_type IN ('internal','external')),
  target_user_id INTEGER REFERENCES users(id),
  token          TEXT UNIQUE,
  expires_at     TIMESTAMPTZ,
  revoked        INTEGER DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_shares_token ON shares(token);
CREATE INDEX idx_shares_owner ON shares(owner_id);
CREATE INDEX idx_shares_target ON shares(target_user_id);

-- System Prompts
CREATE TABLE system_prompts (
  id         SERIAL PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  prompt     TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Skill Registry
CREATE TABLE skill_registry (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK(scope IN ('company','project','personal')),
  project_id  TEXT,
  user_id     INTEGER,
  description TEXT DEFAULT '',
  category    TEXT DEFAULT 'general',
  content     TEXT NOT NULL,
  enabled     INTEGER DEFAULT 1,
  source      TEXT DEFAULT 'bundled',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_skill_scope_name
  ON skill_registry(name, scope, COALESCE(project_id,''), COALESCE(user_id, 0));
CREATE INDEX idx_skill_project ON skill_registry(project_id)
  WHERE project_id IS NOT NULL;
CREATE INDEX idx_skill_user ON skill_registry(user_id)
  WHERE user_id IS NOT NULL;

-- User Skill Preferences
CREATE TABLE user_skill_prefs (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skill_registry(id) ON DELETE CASCADE,
  enabled  INTEGER DEFAULT 1,
  PRIMARY KEY (user_id, skill_id)
);
