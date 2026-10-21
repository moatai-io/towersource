-- Proposed schema. NOT registered with migration runner; approval/review required before application.
CREATE TABLE dashboard_refresh_bindings (
  publication_id text PRIMARY KEY,
  owner_project_id text NOT NULL,
  automation_id text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dashboard_refresh_requests (
  publication_id text NOT NULL REFERENCES dashboard_refresh_bindings(publication_id),
  actor_user_id bigint NOT NULL,
  request_id text NOT NULL,
  binding_version integer NOT NULL,
  state text NOT NULL CHECK(state IN ('claimed','completed','uncertain')),
  run_id text,
  result_status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(publication_id, actor_user_id, request_id)
);
-- A claim survives process restart. Never auto-retry claimed/uncertain execution:
-- crash between runner invocation and receipt persistence requires reconciliation.
