-- Draft schema; apply only through an approved migration. No startup DDL.
CREATE TABLE reviewed_goal_runs (
 id text PRIMARY KEY,
 session_id text NOT NULL REFERENCES sessions(id),
 source_message_id text NOT NULL REFERENCES messages(id),
 owner_token text NOT NULL,
 goal jsonb NOT NULL,
 state text NOT NULL DEFAULT 'running' CHECK(state IN ('running','completed','stopped','needs_input')),
 outcome jsonb,
 events jsonb NOT NULL DEFAULT '[]',
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX reviewed_goal_one_running ON reviewed_goal_runs(session_id) WHERE state='running';
