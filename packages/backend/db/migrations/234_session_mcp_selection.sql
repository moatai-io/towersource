-- Pi conversation MCP opt-outs. Legacy sessions allow all authorized servers.
-- This is only an MCP gateway policy, not a shell/service isolation boundary.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS mcp_excluded_server_names JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_mcp_excluded_server_names_array') THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_mcp_excluded_server_names_array
      CHECK (jsonb_typeof(mcp_excluded_server_names) = 'array');
  END IF;
END $$;
