-- 120: Versioned Agent Harness registry, Project binding, and immutable Session runtime snapshot.
-- Additive migration: existing Projects have no binding and continue through tower-default@v1.

CREATE TABLE IF NOT EXISTS harnesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  visibility TEXT NOT NULL DEFAULT 'system',
  status TEXT NOT NULL DEFAULT 'active',
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS harness_versions (
  harness_id TEXT NOT NULL REFERENCES harnesses(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  engine TEXT NOT NULL,
  manifest JSONB NOT NULL,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (harness_id, version)
);

CREATE TABLE IF NOT EXISTS harness_runtime_profiles (
  id TEXT PRIMARY KEY,
  harness_id TEXT NOT NULL,
  harness_version INTEGER NOT NULL,
  profile_version INTEGER NOT NULL DEFAULT 1,
  policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, harness_id, harness_version),
  FOREIGN KEY (harness_id, harness_version)
    REFERENCES harness_versions(harness_id, version) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_agent_harness_bindings (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  harness_id TEXT NOT NULL,
  harness_version INTEGER NOT NULL,
  runtime_profile_id TEXT NOT NULL,
  bound_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  bound_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (harness_id, harness_version)
    REFERENCES harness_versions(harness_id, version),
  FOREIGN KEY (runtime_profile_id, harness_id, harness_version)
    REFERENCES harness_runtime_profiles(id, harness_id, harness_version)
);

CREATE TABLE IF NOT EXISTS session_runtime_snapshots (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  harness_id TEXT NOT NULL,
  harness_version INTEGER NOT NULL,
  runtime_profile_id TEXT NOT NULL,
  runtime_profile_version INTEGER NOT NULL,
  engine TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  snapshot_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_runtime_snapshots_harness
  ON session_runtime_snapshots(harness_id, harness_version, pinned_at DESC);

INSERT INTO harnesses(id,name,description,visibility,status,current_version)
VALUES
  ('tower-default','Tower Default','Compatibility Harness preserving the existing full Pi surface.','system','active',1),
  ('quick-web-research','Quick Web Research','Restricted Smart-model Harness with WebSearch and WebFetch only.','system','active',1)
ON CONFLICT(id) DO NOTHING;

INSERT INTO harness_versions(harness_id,version,engine,manifest)
VALUES
  ('tower-default',1,'pi','{"builtin":"tower-default-v1"}'::jsonb),
  ('quick-web-research',1,'pi','{"builtin":"quick-web-research-v1"}'::jsonb)
ON CONFLICT(harness_id,version) DO NOTHING;

INSERT INTO harness_runtime_profiles(id,harness_id,harness_version,profile_version,policy,status)
VALUES
  ('standard','tower-default',1,1,'{}'::jsonb,'active'),
  ('web-only','quick-web-research',1,1,'{"capabilityIds":["web.fetch","web.search"]}'::jsonb,'active')
ON CONFLICT(id) DO NOTHING;
