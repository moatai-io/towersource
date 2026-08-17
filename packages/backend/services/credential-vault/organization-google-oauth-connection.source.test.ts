import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const api = readFileSync(new URL('../../routes/api.ts', import.meta.url), 'utf8');
const service = readFileSync(new URL('./credential-vault-service.ts', import.meta.url), 'utf8');

describe('Organization Google OAuth Connection contract', () => {
  it('allows only Admin to start an exact workspace GWS Credential flow', () => {
    const start = api.slice(api.indexOf("router.get('/auth/google/organization'"), api.indexOf("router.get('/auth/google/callback'"));
    expect(start).toContain('authMiddleware');
    expect(start).toContain("user?.role !== 'admin'");
    expect(start).toContain("kind = 'gws'");
    expect(start).toContain("provider = 'google'");
    expect(start).toContain("scope = 'workspace'");
    expect(start).toContain("req.query.mode === 'create' ? 'create' : null");
    expect(start).toContain('mode must be create or reauth');
    expect(start).toContain("mode === 'reauth' && !existing");
    expect(start).toContain("mode === 'create' && existing");
    expect(start).toContain('gws-organization-${Date.now().toString(36)}');
    expect(start).toContain('googleOAuthStateForOrganization');
    expect(api).toContain("aud: 'google-organization-oauth-state'");
  });

  it('routes the signed callback to organization storage without project policy mutation', () => {
    const callback = api.slice(api.indexOf("router.get('/auth/google/callback'"), api.indexOf('// Telegram Bot Linking'));
    expect(callback).toContain("payload?.aud === 'google-organization-oauth-state'");
    expect(callback).toContain("SELECT role, disabled FROM users WHERE id = $1");
    expect(callback).toContain("payload.role !== 'admin'");
    expect(callback).toContain("currentUser?.role !== 'admin'");
    expect(callback).toContain("payload.connectionMode === 'create'");
    expect(callback).toContain("payload.connectionMode === 'reauth'");
    expect(callback).toContain('await upsertOrganizationGwsCredential');
    expect(callback).toContain('credentialId: payload.credentialId!');
  });

  it('creates or rotates one workspace GWS Credential while preserving Agent policies', () => {
    const upsert = service.slice(service.indexOf('export async function upsertOrganizationGwsCredential'), service.indexOf('/** Create or rotate an Agent-owned Google Workspace'));
    expect(upsert).toContain("VALUES ($1, 'gws', 'google'");
    expect(upsert).toContain("'workspace'");
    expect(upsert).toContain("connection_type: 'organization'");
    expect(upsert).toContain("credential_type_id: 'google_oauth'");
    expect(upsert).toContain("connection_type !== 'organization'");
    expect(upsert).toContain("COALESCE(workspace_credentials.metadata, '{}'::jsonb) || EXCLUDED.metadata");
    expect(upsert).not.toContain('setProjectCredentialPolicy');
    expect(upsert).not.toContain('DELETE FROM project_credential_policies');
    expect(upsert).toContain('without changing Agent policies');
  });
});
