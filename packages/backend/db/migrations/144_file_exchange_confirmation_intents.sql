-- 144: Bind File Exchange confirmation to an authenticated user interaction, not a client boolean.
ALTER TABLE file_exchange_plans
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN file_exchange_plans.confirmed_at IS
  'Server-recorded confirmation time after an authenticated browser or interactive Agent callback approves this exact plan.';
COMMENT ON COLUMN file_exchange_plans.confirmed_by_user_id IS
  'Authenticated user who approved this exact File Exchange plan.';
