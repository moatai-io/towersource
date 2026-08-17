-- 088: Keep legacy organization group tables as compatibility shells
--
-- Project access is now controlled exclusively by project_members. Runtime code
-- should not expose or query organization groups anymore.
--
-- IMPORTANT: do not DROP groups/user_groups in this migration. Older dist builds,
-- long-running dev/prod processes, or rollback targets may still contain code that
-- calls getUserGroups() during session/system-prompt creation. Dropping the tables
-- caused live Pi session creation failures with:
--   relation "groups" does not exist
--
-- This migration is intentionally conservative: ensure the compatibility tables
-- exist, even though new code no longer depends on them. A future cleanup can drop
-- them only after all VMs have been deployed/restarted and stale dist artifacts are
-- verified gone.

CREATE TABLE IF NOT EXISTS groups (
  id          SERIAL PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL,
  description TEXT,
  is_global   INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_groups (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, group_id)
);
