-- 143: Record the initiating user/agent principal and delegating user for File Exchange.
ALTER TABLE file_exchange_plans
  ADD COLUMN IF NOT EXISTS principal_ref JSONB NOT NULL DEFAULT '{"kind":"user"}'::jsonb,
  ADD COLUMN IF NOT EXISTS delegated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE file_exchange_receipts
  ADD COLUMN IF NOT EXISTS principal_ref JSONB NOT NULL DEFAULT '{"kind":"user"}'::jsonb,
  ADD COLUMN IF NOT EXISTS delegated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

UPDATE file_exchange_plans
   SET delegated_by_user_id = actor_user_id
 WHERE delegated_by_user_id IS NULL;

UPDATE file_exchange_receipts
   SET delegated_by_user_id = actor_user_id
 WHERE delegated_by_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_file_exchange_receipts_principal_time
  ON file_exchange_receipts ((principal_ref->>'kind'), created_at DESC);

COMMENT ON COLUMN file_exchange_plans.principal_ref IS
  'Server-authored initiating principal snapshot. Agent principals are bound to one Project and Session.';
COMMENT ON COLUMN file_exchange_receipts.delegated_by_user_id IS
  'Authenticated user whose authority the initiating principal used for the transfer.';
