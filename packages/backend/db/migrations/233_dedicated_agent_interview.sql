ALTER TABLE primary_agent_creation_commands ADD COLUMN IF NOT EXISTS interview_session_id text;
ALTER TABLE agent_initial_interviews ADD COLUMN IF NOT EXISTS turns integer NOT NULL DEFAULT 0;
ALTER TABLE agent_initial_interviews ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '[]'::jsonb;
