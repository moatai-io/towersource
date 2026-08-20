import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');

describe('Personal Credential OAuth UI', () => {
  it('puts the primary Google action in the personal credential header', () => {
    expect(source).toContain("primaryOAuthProvider.status === 'not_connected' ? t('credentialConnections.actionLabels.connect')");
    expect(source).toContain("t('credentialConnections.actionLabels.setup')");
    expect(source).toContain("aria-disabled={!primaryOAuthProvider.configured}");
    expect(source).toContain("primaryOAuthProvider.status === 'reauth_required' ? t('credentialConnections.actionLabels.reconnect')");
    expect(source).toContain("t('credentialConnections.actionLabels.change')");
    expect(source).toContain('connectOAuthProvider(primaryOAuthProvider)');
  });

  it('shows personal login accounts without exposing them in global Admin Connections', () => {
    expect(source).toContain('isPersonalCredentialMode && personalSection');
    expect(source).toContain("t('credentialConnections.accountConnection')");
    expect(source).not.toContain('내 Google Workspace 연결');
    expect(source).toContain("provider.status === 'connected' ? t('credentialConnections.connected')");
    expect(source).toContain("provider.status === 'reauth_required' ? t('credentialConnections.reloginRequired')");
    expect(source).toContain("provider.status === 'not_connected' ? t('credentialConnections.actionLabels.connect')");
    expect(source).toContain("t('credentialConnections.actionLabels.setup')");
    expect(source).toContain("provider.configured ? provider.status === 'not_connected'");
  });

  it('keeps the personal page compact with connection and project tabs', () => {
    expect(source).toContain("const [personalSection, setPersonalSection] = useState<'connections' | 'projects'>('connections')");
    expect(source).toContain("t('credentialConnections.connections')");
    expect(source).toContain("t('credentialConnections.projects')");
    expect(source).toContain('max-h-72');
  });

  it('allows personal project policy changes to be saved by non-admin users', () => {
    expect(source).toContain("if ((!canManageGlobalCredentials && !isPersonalCredentialMode) || pendingAccessPolicies.length === 0) return;");
  });

  it('explains that personal credentials follow the requesting user, not one agent', () => {
    expect(source).toContain("t('credentialConnections.personalDescription')");
    expect(source).toContain("t('credentialConnections.personalPrivacyDescription')");
    expect(source).toContain("t('credentialConnections.personalWorkspacesDescription')");
    expect(source).toContain("t('credentialConnections.personalPrivacyDescription')");
    expect(source).toContain("t('credentialConnections.personalCredentialBoundary')");
  });

  it('keeps the broad connection picker for global management only', () => {
    expect(source).toContain("...(!isPersonalCredentialMode ? [");
    expect(source).toContain("title: 'OAuth 계정'");
  });
});
