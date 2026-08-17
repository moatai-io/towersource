-- 131: Bind each Primary Agent approval intent to exactly one creation command.

ALTER TABLE primary_agent_creation_intents
  ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consumed_by_command_id TEXT;

ALTER TABLE primary_agent_creation_intents
  DROP CONSTRAINT IF EXISTS primary_agent_creation_intents_consumed_command_fkey;
ALTER TABLE primary_agent_creation_intents
  ADD CONSTRAINT primary_agent_creation_intents_consumed_command_fkey
  FOREIGN KEY(consumed_by_command_id)
  REFERENCES primary_agent_creation_commands(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_primary_agent_creation_intents_consumed_command
  ON primary_agent_creation_intents(consumed_by_command_id)
  WHERE consumed_by_command_id IS NOT NULL;
