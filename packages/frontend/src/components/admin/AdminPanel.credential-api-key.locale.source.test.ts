import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
const saveStart = source.indexOf('const saveApiKey = async');
const saveEnd = source.indexOf('const saveCredentialBundle = async', saveStart);
const formStart = source.indexOf("{connectionMode === 'api_key_simple' && (");
const formEnd = source.indexOf("(connectionMode === 'api_key' || connectionMode === 'ssh')", formStart);
const apiKeySource = `${source.slice(saveStart, saveEnd)}\n${source.slice(formStart, formEnd)}`;

describe('AdminPanel API key locale routing', () => {
  it('routes API key validation, results, and form copy through locale keys', () => {
    expect(apiKeySource).toContain("t('credentialConnections.apiKey.valueRequired')");
    expect(apiKeySource).toContain("t('credentialConnections.apiKey.saveFailed')");
    expect(apiKeySource).toContain("t('credentialConnections.apiKey.projectGrantFailed')");
    expect(apiKeySource).toContain("'credentialConnections.apiKey.savedWithProject'");
    expect(apiKeySource).toContain("'credentialConnections.apiKey.savedWithoutProject'");
    expect(apiKeySource).toContain("t('credentialConnections.apiKey.addPersonalTitle')");
    expect(apiKeySource).toContain("t('credentialConnections.apiKey.serviceName')");
    expect(apiKeySource).toContain("t('credentialConnections.apiKey.valuePlaceholder')");
    expect(apiKeySource).toContain("t('credentialConnections.apiKey.runtimeHint'");
    expect(apiKeySource).not.toMatch(/[가-힣]/);
  });

  it('preserves Vault save and optional project grant contracts', () => {
    expect(apiKeySource).toContain("'my/credentials/api-key' : 'credentials/api-key'");
    expect(apiKeySource).toContain("method: 'POST'");
    expect(apiKeySource).toContain("'my/projects' : 'projects'");
    expect(apiKeySource).toContain("method: 'PUT'");
    expect(apiKeySource).toContain("mode: 'allow'");
    expect(apiKeySource).toContain('targetEnvName: normalizedForm.defaultEnvName');
    expect(apiKeySource).toContain("setConnectionMode('none')");
  });
});
