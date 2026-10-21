import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const api = readFileSync(new URL('../../routes/api.ts', import.meta.url), 'utf8');
const service = readFileSync(new URL('./credential-vault-service.ts', import.meta.url), 'utf8');

describe('Google OAuth simplified Vault storage contract', () => {
  it('retains Agent and team OAuth callback audiences', () => {
    expect(api).toContain("aud: 'google-agent-oauth-state'");
    expect(api).toContain("aud: 'google-organization-oauth-state'");
    expect(api).toContain('await upsertAgentGwsCredential');
    expect(api).toContain('await upsertOrganizationGwsCredential');
  });

  it('maps organization to workspace and Agent to project scope without policies/defaults', () => {
    expect(service).toContain("scope: 'workspace'");
    expect(service).toContain("scope: 'project'");
    expect(service).not.toContain('workspace_connection_defaults');
    expect(service).not.toContain('runtime_default');
  });
});
