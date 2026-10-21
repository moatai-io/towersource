import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(import.meta.dirname, 'AdminPanel.tsx'), 'utf8');
const credentials = source.slice(source.indexOf('function CredentialVaultManagement'), source.indexOf('// ───── System Tab'));

describe('Admin Credential secret boundary', () => {
  it('does not expose reveal, compare, or structure inspection', () => {
    expect(credentials).not.toContain('/reveal');
    expect(credentials).not.toContain('/compare');
    expect(credentials).not.toContain('/inspect');
    expect(credentials).not.toContain('credentialReveal');
    expect(credentials).not.toContain('advancedActions.reveal');
  });

  it('uses password inputs only for registration and replacement', () => {
    expect(credentials.match(/type="password"/g)?.length).toBe(2);
    expect(credentials).toContain("t('credentialConnections.secretValue')");
    expect(credentials).toContain("t('credentialConnections.newSecretValue')");
  });
});
