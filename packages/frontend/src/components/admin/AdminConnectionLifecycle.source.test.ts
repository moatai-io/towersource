import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
const credentials = source.slice(source.indexOf('function CredentialVaultManagement'), source.indexOf('// ───── System Tab'));

describe('Admin shared Connection lifecycle UX', () => {
  it('offers register, replace, enable, disable, and delete actions', () => {
    expect(credentials).toContain("t('credentialConnections.addConnection')");
    expect(credentials).toContain("t('credentialConnections.replace')");
    expect(credentials).toContain("t('credentialConnections.enable')");
    expect(credentials).toContain("t('credentialConnections.disable')");
    expect(credentials).toContain("t('credentialConnections.delete')");
  });

  it('uses direct lifecycle APIs without advanced reveal or inspection', () => {
    expect(credentials).toContain("body: JSON.stringify({ enabled })");
    expect(credentials).toContain("method: 'DELETE'");
    expect(credentials).not.toContain('/reveal');
    expect(credentials).not.toContain('/inspect');
    expect(credentials).not.toContain('advancedCredentialManagement');
  });
});
