-- 192_simplify_vm_shared_credential_vault.sql
--
-- Collapse the legacy Credential Vault model into two ownership scopes:
--   workspace: shared by the team on this Tower VM
--   project:   owned by one Agent Project
--
-- Secret material remains encrypted in secret_store. This migration never
-- decrypts, returns, logs, or copies a plaintext value.
--
-- tower:migration-lock-risk-reviewed
-- This one-time simplification intentionally combines bounded metadata
-- backfills with constraint and compatibility-table removal.

-- Capture legacy personal ownership before changing credential metadata. The
-- temporary table contains identifiers only; encrypted values remain solely in
-- secret_store.
CREATE TEMP TABLE IF NOT EXISTS _m192_personal_credentials (
  credential_id TEXT PRIMARY KEY,
  old_secret_name TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL,
  promoted_secret_name TEXT NOT NULL,
  delete_google_oauth_client BOOLEAN NOT NULL
) ON COMMIT DROP;

INSERT INTO _m192_personal_credentials (
  credential_id,
  old_secret_name,
  owner_user_id,
  promoted_secret_name,
  delete_google_oauth_client
)
SELECT
  c.id,
  c.secret_name,
  c.owner_user_id,
  'M192_' || upper(md5(c.id || ':' || c.owner_user_id::text)),
  c.provider = 'google'
    AND c.kind = 'api_key'
    AND c.default_env_name IN (
      'GOOGLE_WORKSPACE_CLI_CLIENT_ID',
      'GOOGLE_WORKSPACE_CLI_CLIENT_SECRET'
    )
FROM workspace_credentials c
WHERE c.scope = 'personal'
ON CONFLICT (credential_id) DO NOTHING;

-- Fail closed rather than strand a promoted credential without encrypted
-- material or delete a Google OAuth client referenced by a legacy profile.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM _m192_personal_credentials p
    WHERE NOT p.delete_google_oauth_client
      AND NOT EXISTS (
        SELECT 1
        FROM secret_store s
        WHERE s.name = p.old_secret_name
          AND s.scope = 'user'
          AND s.owner_user_id = p.owner_user_id
      )
  ) THEN
    RAISE EXCEPTION 'migration 192 cannot promote a personal credential without its encrypted Secret Store row';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM _m192_personal_credentials p
    JOIN credential_profiles cp
      ON cp.secret_refs ? p.credential_id
      OR p.credential_id IN (SELECT value FROM jsonb_each_text(cp.secret_refs))
    WHERE p.delete_google_oauth_client
  ) THEN
    RAISE EXCEPTION 'migration 192 refuses to delete a Google OAuth client referenced by a credential profile';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM credential_profiles cp
    CROSS JOIN LATERAL jsonb_each_text(cp.secret_refs) ref
    LEFT JOIN workspace_credentials c ON c.id = ref.value
    WHERE c.id IS NULL
  ) THEN
    RAISE EXCEPTION 'migration 192 cannot preserve a credential profile with a missing secret reference';
  END IF;
END
$$;

-- Promote each remaining personal encrypted secret to a deterministic global
-- Secret Store identity. row_number() chooses one encrypted rotation if a
-- legacy database contains duplicate user-scoped identities.
WITH ranked_source AS (
  SELECT
    p.promoted_secret_name,
    s.value_encrypted,
    s.description,
    s.created_at,
    s.created_by,
    s.rotated_at,
    row_number() OVER (
      PARTITION BY p.credential_id
      ORDER BY s.rotated_at DESC NULLS LAST, s.id DESC
    ) AS source_rank
  FROM _m192_personal_credentials p
  JOIN secret_store s
    ON s.name = p.old_secret_name
   AND s.scope = 'user'
   AND s.owner_user_id = p.owner_user_id
  WHERE NOT p.delete_google_oauth_client
)
INSERT INTO secret_store (
  name,
  value_encrypted,
  scope,
  owner_user_id,
  owner_tool_id,
  description,
  created_at,
  created_by,
  rotated_at
)
SELECT
  src.promoted_secret_name,
  src.value_encrypted,
  'global',
  NULL,
  NULL,
  COALESCE(src.description, 'Promoted from legacy personal Credential Vault scope by migration 192'),
  src.created_at,
  src.created_by,
  src.rotated_at
FROM ranked_source src
WHERE src.source_rank = 1
  AND NOT EXISTS (
    SELECT 1
    FROM secret_store existing
    WHERE existing.name = src.promoted_secret_name
      AND existing.scope = 'global'
  );

UPDATE workspace_credentials c
SET secret_name = p.promoted_secret_name,
    scope = 'workspace',
    owner_user_id = NULL,
    metadata = COALESCE(c.metadata, '{}'::jsonb) || jsonb_build_object(
      'legacy_personal_owner_user_id', p.owner_user_id,
      'scope_migrated_by', 'migration_192'
    ),
    updated_at = now()
FROM _m192_personal_credentials p
WHERE c.id = p.credential_id
  AND NOT p.delete_google_oauth_client;

-- OAuth application client credentials belong to VM configuration, not a
-- user's Connection inventory. Remove exactly the two legacy Google client
-- metadata rows and their user-scoped encrypted rows.
DELETE FROM workspace_credentials c
USING _m192_personal_credentials p
WHERE c.id = p.credential_id
  AND p.delete_google_oauth_client;

DELETE FROM secret_store s
USING _m192_personal_credentials p
WHERE s.name = p.old_secret_name
  AND s.scope = 'user'
  AND s.owner_user_id = p.owner_user_id
  AND NOT EXISTS (
    SELECT 1
    FROM workspace_credentials c
    WHERE c.secret_name = p.old_secret_name
  );

-- User OAuth tokens are superseded by workspace/project Google Connections.
DELETE FROM user_oauth_tokens WHERE provider = 'google';

-- Preserve each profile's non-secret Runtime env and the secret env names on
-- every credential it references. A later Runtime resolver can read this
-- compatibility metadata without keeping the profile/policy tables alive.
WITH profile_refs AS (
  SELECT
    ref.value AS credential_id,
    cp.id AS profile_id,
    jsonb_build_object(
      'profile_type', cp.profile_type,
      'provider', cp.provider,
      'display_name', cp.display_name,
      'env', COALESCE(cp.env, '{}'::jsonb),
      'secret_env_names', to_jsonb(array_agg(ref.key ORDER BY ref.key)),
      'project_ids', COALESCE((
        SELECT jsonb_agg(pp.project_id ORDER BY pp.project_id)
        FROM project_credential_profile_policies pp
        WHERE pp.profile_id = cp.id
          AND pp.mode = 'allow'
      ), '[]'::jsonb),
      'default_connection', COALESCE((
        SELECT jsonb_build_object(
          'default_mode', d.default_mode,
          'project_template', d.project_template,
          'enabled', d.enabled
        )
        FROM workspace_connection_defaults d
        WHERE d.connection_id = 'profile:' || cp.id
      ), 'null'::jsonb),
      'profile_metadata', COALESCE(cp.metadata, '{}'::jsonb),
      'enabled', cp.enabled,
      'migrated_by', 'migration_192'
    ) AS profile_env
  FROM credential_profiles cp
  CROSS JOIN LATERAL jsonb_each_text(cp.secret_refs) ref
  GROUP BY cp.id, ref.value
), credential_profile_env AS (
  SELECT
    credential_id,
    jsonb_object_agg(profile_id, profile_env ORDER BY profile_id) AS profiles
  FROM profile_refs
  GROUP BY credential_id
)
UPDATE workspace_credentials c
SET metadata = COALESCE(c.metadata, '{}'::jsonb) || jsonb_build_object(
      'legacy_profile_env',
      CASE
        WHEN jsonb_typeof(c.metadata -> 'legacy_profile_env') = 'object'
          THEN (c.metadata -> 'legacy_profile_env') || preserved.profiles
        ELSE preserved.profiles
      END
    ),
    updated_at = now()
FROM credential_profile_env preserved
WHERE c.id = preserved.credential_id;

-- Introduce direct Agent ownership before retiring project policy joins.
ALTER TABLE workspace_credentials
  ADD COLUMN IF NOT EXISTS project_id TEXT;

UPDATE workspace_credentials c
SET project_id = c.metadata ->> 'agent_project_id'
WHERE c.scope = 'project'
  AND c.project_id IS NULL
  AND EXISTS (
    SELECT 1 FROM projects p WHERE p.id = c.metadata ->> 'agent_project_id'
  );

WITH one_project_binding AS (
  SELECT
    credential_id,
    min(project_id) AS project_id
  FROM project_credential_policies
  WHERE mode IN ('allow', 'override', 'inherit')
  GROUP BY credential_id
  HAVING count(DISTINCT project_id) = 1
)
UPDATE workspace_credentials c
SET project_id = binding.project_id
FROM one_project_binding binding
WHERE c.id = binding.credential_id
  AND c.scope = 'project'
  AND c.project_id IS NULL;

-- Preserve the effective env override for credentials that remain Agent-owned.
UPDATE workspace_credentials c
SET default_env_name = COALESCE(policy.target_env_name, c.default_env_name),
    metadata = COALESCE(c.metadata, '{}'::jsonb) || jsonb_build_object(
      'legacy_project_policy', jsonb_build_object(
        'mode', policy.mode,
        'target_env_name', policy.target_env_name,
        'metadata', COALESCE(policy.metadata, '{}'::jsonb),
        'migrated_by', 'migration_192'
      )
    ),
    updated_at = now()
FROM project_credential_policies policy
WHERE c.id = policy.credential_id
  AND c.scope = 'project'
  AND c.project_id = policy.project_id;

-- A legacy project credential shared by multiple Agents is VM-team shared.
-- Rows with no defensible Agent owner are also moved to workspace scope but
-- disabled, preventing accidental expansion after policy tables disappear.
UPDATE workspace_credentials c
SET scope = 'workspace',
    project_id = NULL,
    metadata = COALESCE(c.metadata, '{}'::jsonb) || jsonb_build_object(
      'scope_migrated_by', 'migration_192',
      'legacy_project_scope_resolution',
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM project_credential_policies p
          WHERE p.credential_id = c.id
            AND p.mode IN ('allow', 'override', 'inherit')
        ) THEN 'shared_by_multiple_projects'
        ELSE 'no_project_owner_disabled'
      END
    ),
    enabled = CASE
      WHEN EXISTS (
        SELECT 1
        FROM project_credential_policies p
        WHERE p.credential_id = c.id
          AND p.mode IN ('allow', 'override', 'inherit')
      ) THEN c.enabled
      ELSE false
    END,
    updated_at = now()
WHERE c.scope = 'project'
  AND c.project_id IS NULL;

UPDATE workspace_credentials
SET scope = 'workspace',
    project_id = NULL,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'scope_migrated_by', 'migration_192',
      'legacy_scope', 'internal-default'
    ),
    updated_at = now()
WHERE scope = 'internal-default';

UPDATE workspace_credentials
SET project_id = NULL
WHERE scope = 'workspace';

-- Retire credential compatibility tables in FK-safe order. Audit history stays,
-- but its obsolete target-sync pointer is removed before the target table.
DROP TABLE IF EXISTS credential_reveal_challenges;
DROP TABLE IF EXISTS credential_rotate_intents;
DROP TABLE IF EXISTS credential_connection_change_intents;
DROP TABLE IF EXISTS google_connection_cleanup_intents;
DROP TABLE IF EXISTS project_credential_profile_policies;
DROP TABLE IF EXISTS workspace_connection_defaults;
DROP TABLE IF EXISTS credential_profiles;
DROP TABLE IF EXISTS project_credential_policies;

ALTER TABLE IF EXISTS credential_audit_events
  DROP CONSTRAINT IF EXISTS credential_audit_events_target_sync_id_fkey;
ALTER TABLE IF EXISTS credential_audit_events
  DROP COLUMN IF EXISTS target_sync_id;
DROP TABLE IF EXISTS credential_target_syncs;

-- Enforce the two-scope model only after all legacy rows have been converted.
DROP INDEX IF EXISTS workspace_credentials_personal_owner_idx;

ALTER TABLE workspace_credentials
  DROP CONSTRAINT IF EXISTS workspace_credentials_owner_scope_chk;
ALTER TABLE workspace_credentials
  DROP CONSTRAINT IF EXISTS workspace_credentials_scope_chk;
ALTER TABLE workspace_credentials
  DROP CONSTRAINT IF EXISTS workspace_credentials_project_scope_chk;
ALTER TABLE workspace_credentials
  DROP CONSTRAINT IF EXISTS workspace_credentials_project_id_fkey;

ALTER TABLE workspace_credentials
  ADD CONSTRAINT workspace_credentials_scope_chk CHECK (
    scope IN ('workspace', 'project')
  );
ALTER TABLE workspace_credentials
  ADD CONSTRAINT workspace_credentials_project_scope_chk CHECK (
    (scope = 'project' AND project_id IS NOT NULL)
    OR (scope = 'workspace' AND project_id IS NULL)
  );
ALTER TABLE workspace_credentials
  ADD CONSTRAINT workspace_credentials_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE workspace_credentials
  DROP COLUMN IF EXISTS owner_user_id;

CREATE INDEX IF NOT EXISTS workspace_credentials_project_idx
  ON workspace_credentials (project_id, provider, kind)
  WHERE enabled = true AND scope = 'project';

COMMENT ON COLUMN workspace_credentials.project_id IS
  'Owning Agent Project for project-scope credentials; NULL for VM-team workspace credentials.';
COMMENT ON COLUMN workspace_credentials.metadata IS
  'Non-secret compatibility metadata. legacy_profile_env preserves retired profile Runtime env mappings.';
