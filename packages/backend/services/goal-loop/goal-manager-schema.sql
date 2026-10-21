-- Draft only: not a production migration. Apply only to isolated test databases.
CREATE TABLE managed_goals (
  id text PRIMARY KEY,
  record jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (record->>'id' = id)
);
CREATE TABLE goal_dispatch_intents (
  intent_key text PRIMARY KEY,
  goal_id text NOT NULL REFERENCES managed_goals(id),
  expected_goal_version integer NOT NULL CHECK (expected_goal_version > 0),
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','admitted','cancelled')),
  root_turn_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(goal_id, expected_goal_version),
  CHECK ((state = 'admitted') = (root_turn_id IS NOT NULL))
);
CREATE UNIQUE INDEX goal_one_pending_intent ON goal_dispatch_intents(goal_id) WHERE state = 'pending';

-- Internal requests preserve provenance without inserting synthetic user messages.
-- NOT yet consumable by agent_turns (whose root FK currently targets messages).
CREATE TABLE goal_internal_requests (
  id text PRIMARY KEY,
  intent_key text NOT NULL UNIQUE REFERENCES goal_dispatch_intents(intent_key),
  goal_id text NOT NULL REFERENCES managed_goals(id),
  session_id text NOT NULL REFERENCES sessions(id),
  project_id text NOT NULL REFERENCES projects(id),
  user_id integer NOT NULL REFERENCES users(id),
  source_user_message_id text NOT NULL REFERENCES messages(id),
  phase text NOT NULL CHECK (phase IN ('inspect','change','check')),
  goal_version integer NOT NULL CHECK (goal_version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE managed_goal_commands (
  goal_id text NOT NULL REFERENCES managed_goals(id),
  request_id text NOT NULL,
  fingerprint text NOT NULL,
  PRIMARY KEY(goal_id, request_id)
);
CREATE TABLE managed_goal_evidence (
 id text PRIMARY KEY,
 goal_id text NOT NULL REFERENCES managed_goals(id),
 root_turn_id text NOT NULL,
 criterion_id text NOT NULL,
 criterion_hash text NOT NULL CHECK(criterion_hash ~ '^[a-f0-9]{64}$'),
 revision text NOT NULL,
 artifact_digest text NOT NULL CHECK(artifact_digest ~ '^[a-f0-9]{64}$'),
 verifier_id text NOT NULL,
 status text NOT NULL CHECK(status IN ('passed','failed','inconclusive'))
);
CREATE FUNCTION reject_managed_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_GOAL_EVIDENCE'; END $$;
CREATE TRIGGER immutable_managed_evidence BEFORE UPDATE OR DELETE ON managed_goal_evidence
 FOR EACH ROW EXECUTE FUNCTION reject_managed_evidence_mutation();
