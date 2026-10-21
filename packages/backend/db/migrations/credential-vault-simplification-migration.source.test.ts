import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(
  path.join(process.cwd(), 'packages/backend/db/migrations/192_simplify_vm_shared_credential_vault.sql'),
  'utf8',
);

function position(fragment: string): number {
  const index = sql.indexOf(fragment);
  expect(index, `missing migration fragment: ${fragment}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe('Credential Vault two-scope simplification migration', () => {
  it('removes only legacy personal Google OAuth clients and promotes the other personal credentials', () => {
    expect(sql).toContain("c.scope = 'personal'");
    expect(sql).toContain("'GOOGLE_WORKSPACE_CLI_CLIENT_ID'");
    expect(sql).toContain("'GOOGLE_WORKSPACE_CLI_CLIENT_SECRET'");
    expect(sql).toContain("SET secret_name = p.promoted_secret_name");
    expect(sql).toContain("scope = 'workspace'");
    expect(sql).toContain("DELETE FROM user_oauth_tokens WHERE provider = 'google'");
    expect(sql).toContain("'global'");
    expect(sql).not.toMatch(/RAISE NOTICE|RETURNING\s+value_encrypted|SELECT\s+[^;]*value_encrypted\s+FROM/i);
  });

  it('preserves profile Runtime env and secret references before retiring profile tables', () => {
    const preserve = position("'legacy_profile_env'");
    const profileDrop = position('DROP TABLE IF EXISTS credential_profiles');

    expect(sql).toContain("'env', COALESCE(cp.env, '{}'::jsonb)");
    expect(sql).toContain("'secret_env_names', to_jsonb(array_agg(ref.key ORDER BY ref.key))");
    expect(sql).toContain('CROSS JOIN LATERAL jsonb_each_text(cp.secret_refs) ref');
    expect(sql).toContain("'project_ids'");
    expect(sql).toContain("'default_connection'");
    expect(preserve).toBeLessThan(profileDrop);
  });

  it('materializes direct project ownership and constrains credentials to workspace or project scope', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS project_id TEXT');
    expect(sql).toContain("c.metadata ->> 'agent_project_id'");
    expect(sql).toContain("HAVING count(DISTINCT project_id) = 1");
    expect(sql).toContain("'shared_by_multiple_projects'");
    expect(sql).toContain("'no_project_owner_disabled'");
    expect(sql).toContain("scope IN ('workspace', 'project')");
    expect(sql).toContain("scope = 'project' AND project_id IS NOT NULL");
    expect(sql).toContain('FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE');
    expect(sql).toContain('DROP COLUMN IF EXISTS owner_user_id');
  });

  it('drops obsolete tables and the target-sync audit FK in dependency-safe order', () => {
    const profilePolicies = position('DROP TABLE IF EXISTS project_credential_profile_policies');
    const profiles = position('DROP TABLE IF EXISTS credential_profiles');
    const auditFk = position('DROP CONSTRAINT IF EXISTS credential_audit_events_target_sync_id_fkey');
    const auditColumn = position('DROP COLUMN IF EXISTS target_sync_id');
    const targetSyncs = position('DROP TABLE IF EXISTS credential_target_syncs');

    expect(profilePolicies).toBeLessThan(profiles);
    expect(auditFk).toBeLessThan(auditColumn);
    expect(auditColumn).toBeLessThan(targetSyncs);
    for (const table of [
      'credential_reveal_challenges',
      'credential_rotate_intents',
      'credential_connection_change_intents',
      'google_connection_cleanup_intents',
      'workspace_connection_defaults',
      'project_credential_policies',
    ]) {
      expect(sql).toContain(`DROP TABLE IF EXISTS ${table}`);
    }
  });

  it('uses guards and idempotent-compatible DDL without exposing secret values', () => {
    expect(sql).toContain('CREATE TEMP TABLE IF NOT EXISTS _m192_personal_credentials');
    expect(sql).toContain('ON CONFLICT (credential_id) DO NOTHING');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS project_id TEXT');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS');
    expect(sql).toContain('DROP TABLE IF EXISTS');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS workspace_credentials_project_idx');
    expect(sql).toContain('cannot promote a personal credential without its encrypted Secret Store row');
    expect(sql).not.toMatch(/pgp_sym_decrypt|decrypt\s*\(|encode\s*\(\s*value_encrypted|RAISE NOTICE/i);
  });
});
