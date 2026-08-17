-- Session sharing: internal (user-to-user) and external (public link with snapshot)
CREATE TABLE IF NOT EXISTS session_shares (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  owner_id       INTEGER NOT NULL REFERENCES users(id),
  share_type     TEXT NOT NULL CHECK(share_type IN ('internal','external')),
  target_user_id INTEGER REFERENCES users(id),
  token          TEXT UNIQUE,
  expires_at     TIMESTAMPTZ,
  revoked        INTEGER DEFAULT 0,
  -- snapshot: frozen conversation at time of share (external only)
  snapshot_json  TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_shares_token ON session_shares(token);
CREATE INDEX IF NOT EXISTS idx_session_shares_session ON session_shares(session_id);
CREATE INDEX IF NOT EXISTS idx_session_shares_owner ON session_shares(owner_id);
CREATE INDEX IF NOT EXISTS idx_session_shares_target ON session_shares(target_user_id);
