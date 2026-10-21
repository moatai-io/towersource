CREATE TABLE IF NOT EXISTS secretariat_chat_messages (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('user','assistant')), body TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS secretariat_chat_owner ON secretariat_chat_messages(user_id,created_at);
CREATE TABLE IF NOT EXISTS secretariat_chat_leases (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 token TEXT NOT NULL, until_at TIMESTAMPTZ NOT NULL
);
