import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const route = readFileSync(new URL('../../routes/credential-vault-api.ts', import.meta.url), 'utf8');
const service = readFileSync(new URL('./credential-vault-service.ts', import.meta.url), 'utf8');

describe('direct Credential rotation contract', () => {
  it('removes rotate preview intents and rotates through secure input only', () => {
    expect(route).not.toMatch(/rotate\/preview|rotate\/apply|credential_rotate_intents|proposalHash|intentId/);
    expect(route).toContain("router.post('/credentials/:credentialId/rotate'");
    expect(route).toContain("router.post('/projects/:projectId/credentials/:credentialId/rotate'");
  });

  it('never returns the candidate or stored secret', () => {
    expect(route).toContain('publicCredential(credential)');
    expect(service).toContain('normalizeSecretInput(opts.secretValue');
    expect(service).not.toMatch(/console\.log\([^)]*secret/i);
  });
});
