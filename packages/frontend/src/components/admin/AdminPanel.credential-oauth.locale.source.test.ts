import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
const start = source.indexOf('function CredentialVaultManagement');
const end = source.indexOf('// ───── System Tab', start);
const credentialSource = source.slice(start, end);

describe('AdminPanel Credential OAuth removal', () => {
  it('restores shared Google OAuth without personal OAuth', () => {
    expect(credentialSource).toContain('google-organization');
    expect(credentialSource).not.toContain('/auth/oauth/providers');
    expect(credentialSource).not.toContain('connectOAuthProvider');
    expect(credentialSource).not.toContain('disconnectOAuthProvider');
  });
});
