import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');

describe('Admin legacy UI cleanup', () => {
  it('keeps only the implemented shared API-key registration path', () => {
    const credentials = source.slice(source.indexOf('function CredentialVaultManagement'), source.indexOf('// ───── System Tab'));
    expect(credentials).toContain('/credential-vault/credentials/api-key');
    expect(credentials).not.toContain("mode: 'cloud'");
    expect(credentials).not.toContain("mode: 'cli'");
    expect(credentials).not.toContain("mode: 'oauth'");
    expect(credentials).not.toContain("mode: 'ssh'");
    expect(credentials).not.toContain('connectionMode');
  });

  it('removes the unused legacy AI usage wrapper and dashboard', () => {
    expect(source).not.toContain('function AiUsageManagement');
    expect(source).not.toContain('function AiTokenUsageDashboard');
    expect(source).not.toContain('interface AiTokenBudgetSnapshot');
    expect(source).toContain('<UsagePanel embedded />');
  });
});
