import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');

describe('Admin Connection lifecycle UX', () => {
  it('offers plain-language rename, reconnect, safe disconnect, and restore actions', () => {
    expect(source).toContain("t('credentialConnections.connectionName')");
    expect(source).toContain("t('credentialConnections.saveName')");
    expect(source).toContain("t('credentialConnections.reconnectGoogle')");
    expect(source).toContain("t('credentialConnections.disconnectSafely')");
    expect(source).toContain("t('credentialConnections.restoreConnection')");
    expect(source).toContain('/connection`');
  });

  it('explains safe disconnect impact and policy preservation before mutation', () => {
    expect(source).toContain("t('credentialConnections.disconnectConfirmMessage'");
    expect(source).toContain("confirmLabel: t('credentialConnections.disconnectSafely')");
  });

  it('removes manual provider probe from the Agent permission surface', () => {
    const agents = source.slice(source.indexOf("connectionDetailTab === 'agents'"), source.indexOf("connectionDetailTab === 'advanced'", source.indexOf("connectionDetailTab === 'agents'")));
    expect(agents).not.toContain('연결 테스트');
    expect(agents).not.toContain('probeConnectionProject');
  });

  it('moves raw reveal and structure inspection into the advanced tab', () => {
    const advanced = source.slice(source.indexOf("connectionDetailTab === 'advanced'"), source.indexOf("connectionDetailTab === 'agents'"));
    expect(advanced).toContain("t('credentialConnections.advancedCredentialManagement')");
    expect(advanced).toContain("t('credentialConnections.advancedActions.reveal')");
    expect(advanced).toContain("t('credentialConnections.advancedActions.inspect')");
  });
});
