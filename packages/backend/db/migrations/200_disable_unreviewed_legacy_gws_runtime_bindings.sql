-- Data-only follow-up to migration 199. Existing compatibility rows cannot be
-- trusted until an operator records their exact approved bundle digest and path.
UPDATE legacy_gws_runtime_bindings
   SET enabled = false
 WHERE enabled = true
   AND (bundle_sha256 IS NULL OR credential_path IS NULL);
