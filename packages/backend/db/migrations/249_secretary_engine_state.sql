CREATE TABLE IF NOT EXISTS secretariat_engine_state (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 engine_path TEXT NOT NULL, fingerprint TEXT NOT NULL
);
