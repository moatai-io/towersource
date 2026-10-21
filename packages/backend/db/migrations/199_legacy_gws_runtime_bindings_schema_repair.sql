-- Repair installations where an older legacy_gws_runtime_bindings table existed
-- before migration 197 and CREATE TABLE IF NOT EXISTS therefore did not add the
-- bundle identity columns. Keep existing rows disabled until an operator reviews
-- and repopulates their exact approved bundle digest and credential path.
ALTER TABLE legacy_gws_runtime_bindings
  ADD COLUMN IF NOT EXISTS bundle_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS credential_path TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'legacy_gws_runtime_bindings'::regclass
       AND conname = 'legacy_gws_runtime_bindings_bundle_sha256_check'
  ) THEN
    ALTER TABLE legacy_gws_runtime_bindings
      ADD CONSTRAINT legacy_gws_runtime_bindings_bundle_sha256_check
      CHECK (bundle_sha256 IS NULL OR bundle_sha256 ~ '^[a-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'legacy_gws_runtime_bindings'::regclass
       AND conname = 'legacy_gws_runtime_bindings_credential_path_check'
  ) THEN
    ALTER TABLE legacy_gws_runtime_bindings
      ADD CONSTRAINT legacy_gws_runtime_bindings_credential_path_check
      CHECK (credential_path IS NULL OR credential_path ~ '^(users/[0-9]+/)?credentials[.]json$');
  END IF;
END $$;

COMMENT ON COLUMN legacy_gws_runtime_bindings.bundle_sha256 IS
  'Exact approved legacy GWS bundle digest. NULL means the compatibility binding is not reviewed and must remain disabled.';
COMMENT ON COLUMN legacy_gws_runtime_bindings.credential_path IS
  'Approved path inside the legacy GWS bundle. NULL means the compatibility binding is not reviewed and must remain disabled.';
