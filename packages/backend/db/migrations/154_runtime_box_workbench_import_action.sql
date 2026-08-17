-- 154: Allow the controlled legacy project-prefix import action in the Workbench command ledger.

ALTER TABLE runtime_box_workbench_tool_commands
  DROP CONSTRAINT IF EXISTS runtime_box_workbench_tool_commands_action_kind_check;

ALTER TABLE runtime_box_workbench_tool_commands
  ADD CONSTRAINT runtime_box_workbench_tool_commands_action_kind_check
  CHECK (action_kind IN ('install', 'rollback', 'import-project-prefix'));

COMMENT ON CONSTRAINT runtime_box_workbench_tool_commands_action_kind_check
  ON runtime_box_workbench_tool_commands IS
  'Controlled Workbench mutations recorded by the preview/apply command ledger.';
