-- 094_runtime_box_operator_tools_profile.sql
-- Add an operator-tools Runtime Box profile for reproducible ops workbenches.
--
-- The profile changes the Docker image/tooling only. It does not grant
-- credentials or authority; Credential Vault, user role, and Execution Gate
-- still control actual access/mutation.

ALTER TABLE project_runtime_boxes
  DROP CONSTRAINT IF EXISTS project_runtime_boxes_profile_chk;

ALTER TABLE project_runtime_boxes
  ADD CONSTRAINT project_runtime_boxes_profile_chk CHECK (
    runtime_profile IN ('node22-python313', 'operator-tools', 'python313', 'node22', 'custom')
  );

COMMENT ON COLUMN project_runtime_boxes.runtime_profile IS
  'Runtime Box profile/image selector. operator-tools adds ops client CLIs (psql/gh) but no credentials or host authority.';
