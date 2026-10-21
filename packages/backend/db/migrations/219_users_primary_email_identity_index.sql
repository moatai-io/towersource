-- 219: A verified primary identity can belong to only one user row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_primary_email_identity
  ON users(primary_email_identity_id)
  WHERE primary_email_identity_id IS NOT NULL;
