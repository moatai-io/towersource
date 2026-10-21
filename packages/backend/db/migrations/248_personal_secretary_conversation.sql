ALTER TABLE secretariat_chat_messages ADD COLUMN IF NOT EXISTS conversation_id TEXT REFERENCES sessions(id) ON DELETE CASCADE;
