import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const api = readFileSync(new URL('../../routes/api.ts', import.meta.url), 'utf8');
const service = readFileSync(new URL('./credential-vault-service.ts', import.meta.url), 'utf8');

describe('Agent Google OAuth Credential contract', () => {
  it('binds signed OAuth callback storage to the exact Agent Credential', () => {
    expect(api).toContain("aud: 'google-agent-oauth-state'");
    expect(api).toContain('await upsertAgentGwsCredential');
    expect(api).toContain('credentialId: payload.credentialId');
  });

  it('stores Google config as a project Credential owned only by project_id', () => {
    const block = service.slice(service.indexOf('export async function upsertAgentGwsCredential'), service.indexOf('/** @deprecated Project policy'));
    expect(block).toContain("scope: 'project'");
    expect(block).toContain('projectId: opts.projectId');
    expect(block).toContain("credential_type_id: opts.credentialTypeId ?? 'google_oauth'");
    expect(block).not.toContain('project_credential_policies');
    expect(block).not.toContain('runtime_default');
  });
});
