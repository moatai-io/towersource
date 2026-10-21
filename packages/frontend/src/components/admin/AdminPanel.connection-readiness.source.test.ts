import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'AdminPanel.tsx'), 'utf8');
const credentials = source.slice(source.indexOf('function CredentialVaultManagement'), source.indexOf('// ───── System Tab'));

describe('Connection-centered management UI contract', () => {
  it('uses VM Vault as the Admin surface for team-shared and Agent-dedicated Credentials', () => {
    expect(source).toContain("renderTab('credentials', t('navigation.connections'))");
    expect(credentials).toContain("t('credentialConnections.vmVault')");
    expect(credentials).toContain("credential.scope === 'workspace'");
    expect(credentials).toContain("credential.scope === 'project'");
  });

  it('shows a compact card with usage status without fabricated health or usage counts', () => {
    expect(credentials).toContain("t('credentialConnections.vmVaultDescription')");
    expect(credentials).not.toContain("t('credentialConnections.verified')");
    expect(credentials).not.toContain("t('credentialConnections.unverified')");
    expect(credentials).toContain("t('credentialConnections.replace')");
    expect(credentials).toContain("t('credentialConnections.disable')");
    expect(credentials).toContain("t('credentialConnections.delete')");
  });

  it('removes profiles, defaults, targets, advanced reveal, and preview hash flows', () => {
    expect(credentials).not.toContain('credential_profiles');
    expect(credentials).not.toContain('connection-defaults');
    expect(credentials).not.toContain('/targets');
    expect(credentials).not.toContain('/reveal');
    expect(credentials).not.toContain('/inspect');
    expect(credentials).not.toContain('/preview`');
    expect(credentials).not.toContain('proposalHash');
    expect(credentials).not.toContain('intentId');
  });
});
