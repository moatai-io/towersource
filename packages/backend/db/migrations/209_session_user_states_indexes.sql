-- 209_session_user_states_indexes.sql
-- Build lookup indexes separately from the 202 schema transaction to reduce
-- lock-risk coupling during production migration rollout.

CREATE INDEX IF NOT EXISTS idx_session_user_states_subscribed
  ON session_user_states (user_id, session_id)
  WHERE subscription_state = 'subscribed';
