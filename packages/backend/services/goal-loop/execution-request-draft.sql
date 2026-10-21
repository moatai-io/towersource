-- Isolated experiment only. Additive: existing execution FKs are NOT altered.
CREATE TABLE execution_requests_draft (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES sessions(id),
  source_user_message_id text NOT NULL REFERENCES messages(id),
  origin text NOT NULL CHECK(origin IN ('legacy_user','goal')),
  dedupe_key text NOT NULL UNIQUE,
  goal_id text REFERENCES managed_goals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((origin = 'goal') = (goal_id IS NOT NULL)),
  CHECK (origin <> 'legacy_user' OR id = source_user_message_id)
);
-- Refuse unresolved or cross-session roots rather than silently skipping rows.
DO $$ BEGIN
 IF EXISTS (
   SELECT 1 FROM (
     SELECT root_turn_id,session_id FROM agent_turns
     UNION SELECT root_turn_id,session_id FROM side_effect_executions
   ) r LEFT JOIN messages m ON m.id=r.root_turn_id
   WHERE m.id IS NULL OR m.session_id<>r.session_id OR m.role<>'user'
 ) THEN RAISE EXCEPTION 'EXECUTION_BACKFILL_UNRESOLVED_ROOT'; END IF;
END $$;
INSERT INTO execution_requests_draft(id,session_id,source_user_message_id,origin,dedupe_key)
SELECT r.root_turn_id,r.session_id,r.root_turn_id,'legacy_user','legacy:'||r.root_turn_id
FROM (
 SELECT root_turn_id,session_id FROM agent_turns
 UNION SELECT root_turn_id,session_id FROM side_effect_executions
) r;
