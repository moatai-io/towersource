import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const settings = readFileSync(new URL('../settings/SettingsPanel.tsx', import.meta.url), 'utf8');
const connections = readFileSync(new URL('./AgentConnectionsPanel.tsx', import.meta.url), 'utf8');
const modal = readFileSync(new URL('./AgentCredentialsModal.tsx', import.meta.url), 'utf8');

describe('Agent-only Google Connection UX', () => {
  it('removes personal OAuth from general settings', () => {
    expect(settings).not.toContain('OAuthConnections');
    expect(settings).not.toContain('/auth/google');
    expect(settings).not.toContain('canManageConnections');
  });

  it('starts Google OAuth from the target Agent Connection panel', () => {
    expect(connections).toContain('/api/auth/google/agent?projectId=');
    expect(connections).toContain("t('agentGoogle.title')");
    expect(connections).toContain("t('agentGoogle.connectOrReauthorize')");
    expect(connections).toContain("params.get('oauth') !== 'google-agent'");
    expect(connections).toContain('tower-agent-credentials-changed');
  });

  it('reauthenticates Google OAuth instead of rotating its raw value', () => {
    expect(modal).toContain("credential.allowedActions?.replacementAction === 'reauth'");
    expect(modal).toContain('reauthenticateGoogle(credential.id)');
    expect(modal).toContain('/api/auth/google/agent?projectId=');
  });

  it('does not expose Google default account selection', () => {
    expect(connections).toContain("connection.origin === 'agent'");
    expect(connections).toContain("t('agentGoogle.organizationAccountsTitle')");
    expect(connections).not.toContain('/google-connections/');
    expect(connections).not.toContain('useAsDefault');
    expect(connections).not.toContain('defaultBadge');
  });

  it('keeps semantic theme classes and accessible controls', () => {
    expect(connections).not.toMatch(/(?:text|bg|border)-(?:gray|slate)-/);
    expect(connections).toContain('focus-visible:ring-2');
    expect(connections).toContain('min-h-10');
  });
});
