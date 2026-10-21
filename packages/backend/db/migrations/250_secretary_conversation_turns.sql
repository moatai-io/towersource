CREATE TABLE IF NOT EXISTS secretariat_conversation_turns (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('running','completed','stopped','failed','interrupted')),
 started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ,
 compact_count INTEGER NOT NULL DEFAULT 0, input_tokens BIGINT NOT NULL DEFAULT 0,
 output_tokens BIGINT NOT NULL DEFAULT 0, cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS secretary_turn_owner ON secretariat_conversation_turns(user_id,started_at DESC);
