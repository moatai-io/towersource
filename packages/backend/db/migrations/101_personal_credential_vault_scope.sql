-- 101_personal_credential_vault_scope.sql — first-class personal Credential Vault scope
--
-- Decision: workspace/decisions/2026-07-01-personal-credential-vault-scope.md
--
-- Personal credentials are owned by one Tower user. Secret values continue to
-- live in secret_store with scope='user'; workspace_credentials stores only
-- metadata, owner, project policy, and audit identifiers.

ALTER TABLE workspace_credentials
  ADD COLUMN IF NOT EXISTS owner_user_id INT REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE workspace_credentials
  DROP CONSTRAINT IF EXISTS workspace_credentials_scope_chk;

ALTER TABLE workspace_credentials
  ADD CONSTRAINT workspace_credentials_scope_chk CHECK (
    scope IN ('workspace', 'internal-default', 'project', 'personal')
  );

ALTER TABLE workspace_credentials
  DROP CONSTRAINT IF EXISTS workspace_credentials_owner_scope_chk;

ALTER TABLE workspace_credentials
  ADD CONSTRAINT workspace_credentials_owner_scope_chk CHECK (
    (scope = 'personal' AND owner_user_id IS NOT NULL)
    OR (scope <> 'personal' AND owner_user_id IS NULL)
  );

CREATE INDEX IF NOT EXISTS workspace_credentials_personal_owner_idx
  ON workspace_credentials (owner_user_id, provider, kind)
  WHERE enabled = true AND scope = 'personal';

COMMENT ON COLUMN workspace_credentials.owner_user_id IS
  'Owner for personal Credential Vault metadata. Secret values are stored in secret_store with scope=user.';
