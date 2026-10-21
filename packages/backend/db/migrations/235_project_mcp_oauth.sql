-- OAuth values remain in the existing AES-GCM secret_store; no token JSON in these tables.
CREATE TABLE IF NOT EXISTS project_mcp_connections (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  server_name text NOT NULL,
  server_url text NOT NULL,
  secret_name text NOT NULL,
  secret_owner_user_id integer NOT NULL REFERENCES users(id),
  connected boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, server_name)
);
CREATE TABLE IF NOT EXISTS project_mcp_oauth_states (
  state_hash text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  server_name text NOT NULL,
  server_url text NOT NULL,
  actor_user_id integer NOT NULL REFERENCES users(id),
  secret_name text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, server_name)
);
CREATE INDEX IF NOT EXISTS project_mcp_oauth_states_expiry ON project_mcp_oauth_states(expires_at);
