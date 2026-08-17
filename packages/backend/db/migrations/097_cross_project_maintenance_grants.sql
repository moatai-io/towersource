-- 097: Cross-project maintenance grants
--
-- Issue #108: make admin/operator cross-project scaffold maintenance explicit
-- instead of relying on cwd or workspace-root access.
--
-- Initial MVP only records grants/audit schema. Enforcement/API will wire this
-- table before broad scaffold migrations become user-facing.
-- Decision: workspace/decisions/2026-06-21-cross-project-continuation-and-maintenance.md

CREATE TABLE IF NOT EXISTS cross_project_maintenance_grants (
  id                TEXT PRIMARY KEY,
  actor_user_id     INTEGER NOT NULL REFERENCES users(id),
  source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  reason            TEXT NOT NULL,

  -- 'selected_projects' | 'all_projects'
  scope_type        TEXT NOT NULL DEFAULT 'selected_projects',
  project_ids       JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- e.g. ['AGENTS.md', 'CLAUDE.md', '.project/**', '.tower/skills/**']
  allowed_paths     JSONB NOT NULL DEFAULT '[]'::jsonb,
  mode              TEXT NOT NULL DEFAULT 'dry_run', -- dry_run | apply
  status            TEXT NOT NULL DEFAULT 'active',  -- active | used | expired | revoked

  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at           TIMESTAMPTZ,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT cpmg_scope_type_chk CHECK (scope_type IN ('selected_projects', 'all_projects')),
  CONSTRAINT cpmg_mode_chk CHECK (mode IN ('dry_run', 'apply')),
  CONSTRAINT cpmg_status_chk CHECK (status IN ('active', 'used', 'expired', 'revoked'))
);

CREATE INDEX IF NOT EXISTS idx_cpmg_actor_created
  ON cross_project_maintenance_grants(actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cpmg_session_created
  ON cross_project_maintenance_grants(source_session_id, created_at DESC)
  WHERE source_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cpmg_active_expiry
  ON cross_project_maintenance_grants(expires_at)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS cross_project_maintenance_events (
  id          BIGSERIAL PRIMARY KEY,
  grant_id    TEXT REFERENCES cross_project_maintenance_grants(id) ON DELETE SET NULL,
  actor_user_id INTEGER REFERENCES users(id),
  session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
  file_path   TEXT,
  action      TEXT NOT NULL, -- preview | write | mkdir | edit | skip | deny
  outcome     TEXT NOT NULL DEFAULT 'ok', -- ok | error | denied
  diff_summary TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cpme_grant_created
  ON cross_project_maintenance_events(grant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cpme_project_created
  ON cross_project_maintenance_events(project_id, created_at DESC)
  WHERE project_id IS NOT NULL;
