import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(import.meta.dirname, 'AdminPanel.tsx'), 'utf8');
const ko = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../locales/ko/admin.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../locales/en/admin.json'), 'utf8'));

describe('Admin VM Vault surface', () => {
  it('loads full inventory and renders summary, Agent Credentials, promotion, and audit', () => {
    expect(source).toContain('/credential-vault/admin-overview');
    expect(source).toContain("credential.scope === 'project'");
    expect(source).toContain("t('credentialConnections.vmVault')");
    expect(source).toContain("t('credentialConnections.agentCredentials')");
    expect(source).toContain('promoteCredential(credential)');
    expect(source).toContain("t('credentialConnections.auditTitle')");
  });

  it('uses the current lifecycle endpoint for team-shared enable and disable', () => {
    expect(source).toContain("body: JSON.stringify({ enabled })");
    expect(source).not.toContain('/connection`,');
  });

  it('defines new VM Vault copy in English and Korean', () => {
    for (const locale of [ko, en]) {
      const copy = locale.credentialConnections;
      for (const key of ['vmVault', 'vmVaultDescription', 'agentCredentials', 'promote', 'auditTitle', 'emptyAudit']) {
        expect(copy[key], key).toEqual(expect.any(String));
      }
      expect(copy.summary).toMatchObject({ total: expect.any(String), workspace: expect.any(String), project: expect.any(String), orphaned: expect.any(String) });
    }
  });
});
