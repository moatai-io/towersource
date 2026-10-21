import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
const credentials = source.slice(source.indexOf('function CredentialVaultManagement'), source.indexOf('// ───── System Tab'));

describe('AdminPanel shared Connection registration', () => {
  it('routes the compact registration form through locale keys', () => {
    for (const key of ['provider', 'displayName', 'runtimeName', 'secretValue', 'addConnection']) {
      expect(credentials).toContain(`t('credentialConnections.${key}')`);
    }
  });

  it('registers only a workspace-scoped shared API key', () => {
    expect(credentials).toContain('/credential-vault/credentials/api-key');
    expect(credentials).toContain("scope: 'workspace'");
    expect(credentials).toContain("method: 'POST'");
    expect(credentials).not.toContain('my/credentials');
    expect(credentials).not.toContain('project-policies');
  });
});
