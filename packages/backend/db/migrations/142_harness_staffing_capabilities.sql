-- 142: Declare versioned staffing capability metadata without changing runtime tool allowlists.
-- Staffing capabilities describe role fit in the AI talent-team flow. Runtime
-- capabilities remain the executable provider allowlist in effective_manifest.capabilityIds.

ALTER TABLE harness_versions
  ADD COLUMN IF NOT EXISTS staffing_capability_ids JSONB;

UPDATE harness_versions
   SET staffing_capability_ids = CASE
     WHEN harness_id='tower-default' AND version=1 THEN
       '["browser_render","code_edit","contact_research","email_draft","project_file_read","project_file_write","public_web_research","spreadsheet_write","static_site_preview","web_build"]'::jsonb
     WHEN harness_id='quick-web-research' AND version=1 THEN
       '["public_web_research"]'::jsonb
     ELSE COALESCE(effective_manifest->'capabilityIds', manifest->'capabilityIds', '[]'::jsonb)
   END
 WHERE staffing_capability_ids IS NULL;

ALTER TABLE harness_versions
  ALTER COLUMN staffing_capability_ids SET DEFAULT '[]'::jsonb;
ALTER TABLE harness_versions
  ALTER COLUMN staffing_capability_ids SET NOT NULL;

ALTER TABLE harness_versions
  DROP CONSTRAINT IF EXISTS harness_versions_staffing_capability_ids_array_check;
ALTER TABLE harness_versions
  ADD CONSTRAINT harness_versions_staffing_capability_ids_array_check
  CHECK (jsonb_typeof(staffing_capability_ids) = 'array');

COMMENT ON COLUMN harness_versions.staffing_capability_ids IS
  'Versioned role-fit metadata for Primary Agent staffing. Not a runtime tool authority grant.';
