import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');

describe('Admin Connection project action feedback', () => {
  it('keeps a project-row error after preview or apply failure', () => {
    expect(source).toContain('const [connectionProjectErrors, setConnectionProjectErrors]');
    expect(source).toContain('setConnectionProjectErrors(current => ({ ...current, [key]: message }))');
    expect(source).toContain('role="alert"');
    expect(source).toContain("t('credentialConnections.connectionFailed', { error: rowError })");
  });

  it('offers an explicit retry action instead of silently returning to connect', () => {
    expect(source).toContain("rowError && !connected ? t('credentialConnections.retry') : connected ? t('credentialConnections.disconnect') : t('credentialConnections.connect')");
    expect(source).toContain('delete next[key]');
  });

  it('keeps Agent rows focused on lifecycle actions instead of provider-specific probes', () => {
    const agents = source.slice(source.indexOf("connectionDetailTab === 'agents'"), source.indexOf("connectionDetailTab === 'advanced'", source.indexOf("connectionDetailTab === 'agents'")));
    expect(agents).not.toContain('probeConnectionProject');
    expect(agents).not.toContain('연결 테스트');
    expect(source).toContain("rowError && !connected ? t('credentialConnections.retry') : connected ? t('credentialConnections.disconnect') : t('credentialConnections.connect')");
  });
});
