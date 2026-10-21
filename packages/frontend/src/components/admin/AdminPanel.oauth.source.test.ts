import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
const header = readFileSync(new URL('../layout/Header.tsx', import.meta.url), 'utf8');

describe('removed personal Credential and OAuth UI', () => {
  it('keeps the legacy lazy-import export inert', () => {
    const panel = source.slice(source.indexOf('export function PersonalCredentialsPanel'), source.indexOf('function CredentialVaultManagement'));
    expect(panel).toContain('return null');
    expect(panel).not.toContain('mode="personal"');
    expect(panel).not.toContain('my/credentials');
  });

  it('removes the personal Credential navigation item', () => {
    expect(header).not.toContain('testId="global-nav-personal-credentials"');
    expect(header).not.toContain("label={t('personalCredentials')}");
  });

  it('removes personal OAuth and project-policy management from the Credential tab', () => {
    const credentials = source.slice(source.indexOf('function CredentialVaultManagement'), source.indexOf('// ───── System Tab'));
    expect(credentials).not.toContain('/auth/oauth/providers');
    expect(credentials).toContain('google-organization');
    expect(credentials).not.toContain('project-policies');
    expect(credentials).not.toContain('isPersonalCredentialMode');
  });
});
