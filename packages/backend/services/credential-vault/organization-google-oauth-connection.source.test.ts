import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const api = readFileSync(new URL('../../routes/api.ts', import.meta.url), 'utf8');
const service = readFileSync(new URL('./credential-vault-service.ts', import.meta.url), 'utf8');

describe('team-shared Google OAuth Credential contract', () => {
  it('routes signed organization callback to shared Credential storage', () => {
    expect(api).toContain("payload?.aud === 'google-organization-oauth-state'");
    expect(api).toContain('await upsertOrganizationGwsCredential');
  });

  it('stores one workspace-scoped Google credential without Agent policy mutation', () => {
    const block = service.slice(service.indexOf('export async function upsertOrganizationGwsCredential'), service.indexOf('export async function upsertAgentGwsCredential'));
    expect(block).toContain("scope: 'workspace'");
    expect(block).toContain("credential_type_id: 'google_oauth'");
    expect(block).not.toMatch(/project_credential_policies|setProjectCredentialPolicy|workspace_connection_defaults/);
  });
});
