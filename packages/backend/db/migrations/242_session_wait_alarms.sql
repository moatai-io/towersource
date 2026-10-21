-- Durable one-shot session waits. An alarm is a new turn admission, not a side-effect guarantee.
CREATE TABLE IF NOT EXISTS session_wait_alarms (
 id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 source_root_turn_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','admitted','cancelled','superseded')),
 wake_at TIMESTAMPTZ NOT NULL,
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 version INTEGER NOT NULL DEFAULT 1,
 resume_message_id TEXT NOT NULL UNIQUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS session_wait_alarms_pending ON session_wait_alarms(session_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS session_wait_alarms_due ON session_wait_alarms(wake_at) WHERE status='pending';
