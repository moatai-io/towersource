import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const api = readFileSync(new URL('../../routes/credential-vault-api.ts', import.meta.url), 'utf8');

describe('Organization Connection lifecycle contract', () => {
  const route = api.slice(api.indexOf("router.patch('/credentials/:credentialId/connection'"), api.indexOf("router.post('/credentials/:credentialId/rotate/preview'"));

  it('requires Admin and limits lifecycle changes to organization Credentials', () => {
    expect(route).toContain('assertAdmin(req)');
    expect(route).toContain("scope IN ('workspace', 'internal-default')");
    expect(route).toContain("['disconnect', 'restore']");
  });

  it('safely disconnects by disabling the Credential without deleting secret or policies', () => {
    expect(route).toContain("lifecycle === 'disconnect' ? false");
    expect(route).toContain('UPDATE workspace_credentials');
    expect(route).not.toContain('DELETE FROM workspace_credentials');
    expect(route).not.toContain('DELETE FROM project_credential_policies');
    expect(route).not.toContain('deleteSecret');
    expect(route).toContain('policiesPreserved: true');
    expect(route).toContain('secretPreserved: true');
  });

  it('records rename, disconnect, and restore in the audit ledger without secret material', () => {
    expect(route).toContain('connection_safely_disconnected');
    expect(route).toContain('connection_restored');
    expect(route).toContain('connection_renamed');
    expect(route).toContain("target_type, status, message, metadata");
  });
});
