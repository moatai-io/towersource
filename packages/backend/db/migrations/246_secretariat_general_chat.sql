ALTER TABLE secretariat_chat_messages ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE secretariat_chat_messages ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE secretariat_chat_messages ADD CONSTRAINT secretariat_chat_context_pair CHECK ((project_id IS NULL) = (session_id IS NULL));
