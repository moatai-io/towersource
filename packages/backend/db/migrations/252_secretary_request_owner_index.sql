CREATE UNIQUE INDEX IF NOT EXISTS secretary_request_owner ON secretariat_conversation_turns(user_id,request_id) WHERE request_id IS NOT NULL;
