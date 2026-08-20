import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
const start = source.indexOf('function CredentialVaultManagement');
const end = source.indexOf('// ─────', start + 1);
const credentialSource = source.slice(start, end > start ? end : undefined);

describe('AdminPanel credential common locale routing', () => {
  it('routes shared Credential chrome through admin locale keys', () => {
    expect(credentialSource).toContain("t('credentialConnections.serviceConnections')");
    expect(credentialSource).toContain("t('credentialConnections.advancedManagement')");
    expect(credentialSource).toContain("t('credentialConnections.advancedManagementDescription')");
    expect(credentialSource).toContain("t('credentialConnections.collapse')");
    expect(credentialSource).toContain("t('credentialConnections.expand')");
    expect(credentialSource).toContain("t('credentialConnections.addExternalConnection')");
    expect(credentialSource).toContain("t('credentialConnections.addExternalConnectionDescription')");
  });

  it('preserves the advanced-management and connection-mode behavior contracts', () => {
    expect(credentialSource).toContain('aria-expanded={showAdvanced}');
    expect(credentialSource).toContain('setShowAdvanced(value => !value)');
    expect(credentialSource).toContain("connectionMode !== 'none'");
    expect(credentialSource).toContain("setConnectionMode('none')");
  });
});
