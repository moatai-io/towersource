import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const adminSource = readFileSync(resolve(process.cwd(), 'packages/frontend/src/components/admin/AdminPanel.tsx'), 'utf8');
const en = JSON.parse(readFileSync(resolve(process.cwd(), 'packages/frontend/src/locales/en/admin.json'), 'utf8'));
const ko = JSON.parse(readFileSync(resolve(process.cwd(), 'packages/frontend/src/locales/ko/admin.json'), 'utf8'));

describe('AdminPanel Connections locale contract', () => {
  it('defines every connection status key used by the panel in both locales', () => {
    const required = [
      'health.disabled',
      'health.syncError',
      'health.syncAttention',
      'health.vaultStored',
      'connectionStatus.connected',
      'connectionStatus.needsAttention',
      'connectionStatus.disabled',
      'connectionStatus.off',
      'readiness.ready',
      'readiness.invalid',
      'readiness.reauthRequired',
      'readiness.degraded',
      'readiness.connectedUnverified',
      'readiness.readyDescription',
      'readiness.invalidDescription',
      'readiness.reauthDescription',
      'readiness.degradedDescription',
      'readiness.connectedUnverifiedDescription',
      'readiness.disabledDescription',
      'readiness.unusedDescription',
      'primaryAction',
    ];

    for (const path of required) {
      const get = (value: Record<string, unknown>) => path.split('.').reduce<unknown>((current, part) => (
        current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined
      ), value);
      expect(get(en.credentialConnections), path).toEqual(expect.any(String));
      expect(get(ko.credentialConnections), path).toEqual(expect.any(String));
    }
  });

  it('routes connection readiness labels through the admin locale', () => {
    expect(adminSource).toContain("adminText('credentialConnections.readiness.ready')");
    expect(adminSource).toContain("adminText('credentialConnections.connectionStatus.connected')");
    expect(adminSource).toContain("adminText('credentialConnections.primaryAction')");
  });
});
