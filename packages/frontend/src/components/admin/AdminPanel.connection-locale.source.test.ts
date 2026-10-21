import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const adminSource = readFileSync(resolve(process.cwd(), 'packages/frontend/src/components/admin/AdminPanel.tsx'), 'utf8');
const en = JSON.parse(readFileSync(resolve(process.cwd(), 'packages/frontend/src/locales/en/admin.json'), 'utf8'));
const ko = JSON.parse(readFileSync(resolve(process.cwd(), 'packages/frontend/src/locales/ko/admin.json'), 'utf8'));

describe('AdminPanel simplified Connections locale contract', () => {
  const required = [
    'teamConnections', 'teamConnectionsDescription', 'loadFailed', 'saveFailed',
    'statusFailed', 'replaceFailed', 'deleteFailed', 'emptyTeamConnections',
    'provider', 'displayName', 'runtimeName', 'secretValue', 'newSecretValue',
    'replace', 'enable', 'disable', 'delete', 'agentUsageCount',
  ];

  it('defines every visible key in English and Korean', () => {
    for (const key of required) {
      expect(en.credentialConnections[key], key).toEqual(expect.any(String));
      expect(ko.credentialConnections[key], key).toEqual(expect.any(String));
    }
  });

  it('routes VM Vault copy through the admin locale', () => {
    for (const key of ['vmVault', 'vmVaultDescription', 'agentCredentials', 'agentCredentialsDescription', 'auditTitle']) {
      expect(adminSource).toContain(`t('credentialConnections.${key}`);
    }
  });
});
