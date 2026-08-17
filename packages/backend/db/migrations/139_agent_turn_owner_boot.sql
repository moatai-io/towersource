-- 139: Identify which backend boot owns a recovery lease.
-- Startup recovery may immediately fence a lease from an older boot while
-- same-boot workers still respect the normal lease window.

ALTER TABLE agent_turns
  ADD COLUMN IF NOT EXISTS owner_boot_id TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_turns_owner_boot
  ON agent_turns(owner_boot_id)
  WHERE state = 'running' AND owner_token IS NOT NULL;
