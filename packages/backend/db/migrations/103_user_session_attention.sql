-- 103_user_session_attention.sql
-- Persist per-user Latest/Inbox attention state so hard refresh and backend restart
-- can reconstruct which sessions still need attention.
--
-- `session_updated_at` is stored as text because the frontend's Latest dismiss key
-- is `${session.id}:${session.updatedAt}`. Keeping the exact client-visible stamp
-- preserves the "dismiss this update only; show again after the next update" contract.

BEGIN;

CREATE TABLE IF NOT EXISTS user_session_attention (
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id         TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  session_updated_at TEXT,
  state              TEXT    NOT NULL CHECK (state IN ('unread', 'recently_read', 'dismissed')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, session_id, state)
);

CREATE INDEX IF NOT EXISTS idx_user_session_attention_user
  ON user_session_attention (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_session_attention_session
  ON user_session_attention (session_id);

COMMIT;
