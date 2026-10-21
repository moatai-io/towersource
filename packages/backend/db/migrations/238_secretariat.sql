-- TOW-129: opt-in, personal, app-internal Secretariat proposal inbox.
-- Schema only; applying this migration is an operator-approved deployment step.
CREATE TABLE IF NOT EXISTS secretariat_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  generation INTEGER NOT NULL DEFAULT 0,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claim_token TEXT,
  claim_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS secretariat_runs (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  occurrence TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'skipped', 'failed', 'proposed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  UNIQUE(user_id, occurrence)
);
CREATE TABLE IF NOT EXISTS secretariat_proposals (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ,
  UNIQUE(user_id, source_key)
);
-- A concurrent worker must never deliver another proposal while one is unread.
CREATE UNIQUE INDEX IF NOT EXISTS secretariat_one_unread
  ON secretariat_proposals(user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS secretariat_due ON secretariat_settings(next_run_at) WHERE enabled;
CREATE INDEX IF NOT EXISTS secretariat_inbox ON secretariat_proposals(user_id, created_at DESC);
