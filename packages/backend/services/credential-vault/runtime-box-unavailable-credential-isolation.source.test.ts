import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const service = readFileSync(new URL('./credential-vault-service.ts', import.meta.url), 'utf8');

function block(name: string, nextName?: string): string {
  const start = service.indexOf(`export async function ${name}`);
  const end = nextName ? service.indexOf(`export async function ${nextName}`, start + 1) : service.length;
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return service.slice(start, end);
}

describe('Runtime unavailable Credential isolation contract', () => {
  it('skips unavailable env and file credentials without blocking unrelated credentials', () => {
    for (const body of [block('resolveRuntimeBoxApiKeyEnv', 'resolveRuntimeBoxCredentialFileMaterialization'), block('resolveRuntimeBoxCredentialFileMaterialization', 'hasProjectApiKeyCredential')]) {
      expect(body).toContain('try {');
      expect(body).toContain('catch (error: any)');
      expect(body).toContain('skipped.push({');
      expect(body).toContain('credential unavailable; skipped');
    }
  });

  it('keeps explicitly selected credential resolution fail-closed through getSecret', () => {
    expect(block('resolveProjectApiKeySecretValue', 'resolveProjectCredentialSecretValue')).toContain('await getSecret');
    expect(block('resolveProjectCredentialSecretValue', 'listWorkspaceCredentials')).toContain('await getSecret');
  });
});
