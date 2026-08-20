import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
const credentialStart = source.indexOf('function CredentialVaultManagement');
const start = source.indexOf("if (params.get('oauth') !== 'google-organization')", credentialStart);
const end = source.indexOf('const saveApiKey = async', start);
const oauthSource = source.slice(start, end);

describe('AdminPanel Credential OAuth locale routing', () => {
  it('routes OAuth callback, connection, and disconnection feedback through locale keys', () => {
    expect(oauthSource).toContain("t('credentialConnections.oauth.organizationGoogleSaved')");
    expect(oauthSource).toContain("t('credentialConnections.oauth.organizationGoogleSaveFailed')");
    expect(oauthSource).toContain("t('credentialConnections.oauth.organizationGoogleStartFailed')");
    expect(oauthSource).toContain("t('credentialConnections.oauth.clientNotConfigured'");
    expect(oauthSource).toContain("t('credentialConnections.oauth.loginUrlFailed')");
    expect(oauthSource).toContain("t('credentialConnections.oauth.connectionStartFailed')");
    expect(oauthSource).toContain("t('credentialConnections.oauth.disconnectTitle'");
    expect(oauthSource).toContain("t('credentialConnections.oauth.disconnectConfirm')");
    expect(oauthSource).toContain("t('credentialConnections.oauth.disconnectFailed')");
    expect(oauthSource).toContain("t('credentialConnections.oauth.disconnected'");
  });

  it('preserves OAuth callback cleanup and provider API contracts', () => {
    expect(oauthSource).toContain("params.get('oauth') !== 'google-organization'");
    expect(oauthSource).toContain("params.delete('credentialId')");
    expect(oauthSource).toContain('/auth/google/organization');
    expect(oauthSource).toContain('fetch(provider.authPath');
    expect(oauthSource).toContain('/auth/oauth/${encodeURIComponent(provider.id)}');
    expect(oauthSource).toContain("method: 'DELETE'");
    expect(oauthSource).not.toMatch(/[가-힣]/);
  });
});
