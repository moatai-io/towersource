import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
const start = source.indexOf('function CredentialVaultManagement');
const end = source.indexOf('// ───── System Tab', start);
const credentialSource = source.slice(start, end);

describe('AdminPanel simplified Connection locale routing', () => {
  it('routes the team Connection surface through admin locale keys', () => {
    for (const key of [
      'credentialConnections.vmVault',
      'credentialConnections.vmVaultDescription',
      'credentialConnections.addConnection',
      'credentialConnections.replace',
      'credentialConnections.enable',
      'credentialConnections.disable',
      'credentialConnections.delete',
    ]) expect(credentialSource).toContain(`t('${key}')`);
  });

  it('removes advanced, policy, default, profile, and target management', () => {
    expect(credentialSource).not.toContain('advancedManagement');
    expect(credentialSource).not.toContain('connection-defaults');
    expect(credentialSource).not.toContain('project-policies');
    expect(credentialSource).not.toContain('bundle-types');
    expect(credentialSource).not.toContain('/targets');
  });
});
