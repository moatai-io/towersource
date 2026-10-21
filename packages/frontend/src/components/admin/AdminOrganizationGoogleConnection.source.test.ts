import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
const credentials = source.slice(source.indexOf('function CredentialVaultManagement'), source.indexOf('// ───── System Tab'));

describe('Admin team-shared Google OAuth', () => {
  it('uses the organization endpoint with explicit create/reauth modes', () => {
    expect(credentials).toContain('/auth/google/organization?${params}');
    expect(credentials).toContain("mode: credentialId ? 'reauth' : 'create'");
    expect(credentials).toContain("params.set('credentialId', credentialId)");
    expect(credentials).toContain("message: t('credentialConnections.googleScopeNotice')");
    expect(credentials).not.toContain('/auth/oauth');
  });

  it('handles callback success/error and removes only OAuth query parameters', () => {
    expect(credentials).toContain("params.get('oauth') !== 'google-organization'");
    expect(credentials).toContain('credentialConnections.oauth.organizationGoogleSaved');
    expect(credentials).toContain('credentialConnections.oauth.organizationGoogleSaveFailed');
    expect(credentials).toContain('window.history.replaceState');
  });

  it('reauthenticates Google instead of offering raw token replacement', () => {
    expect(credentials).toContain("isGoogle ? void connectGoogle(connection.credentialId) : setReplacement({ connection, value: '' })");
    const modal = readFileSync(new URL('../layout/AgentCredentialsModal.tsx', import.meta.url), 'utf8');
    expect(modal).toContain('/api/auth/google/agent?projectId=');
  });
});
