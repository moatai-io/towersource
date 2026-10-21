CREATE TABLE IF NOT EXISTS agent_initial_interviews (
 project_id text PRIMARY KEY, session_id text NOT NULL, actor_user_id integer NOT NULL,
 status text NOT NULL DEFAULT 'scheduled', attempt integer NOT NULL DEFAULT 0,
 lease_until timestamptz, token text, question_id text, question text, artifact_message_id text,
 answer text, answer_message_id text, updated_at timestamptz NOT NULL DEFAULT now()
);
