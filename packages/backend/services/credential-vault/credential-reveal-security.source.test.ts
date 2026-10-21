import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const route = readFileSync(new URL('../../routes/credential-vault-api.ts', import.meta.url), 'utf8');
const service = readFileSync(new URL('./credential-vault-service.ts', import.meta.url), 'utf8');

describe('trusted Credential reveal contract', () => {
  it('uses one simple audited reveal route without compare or challenge machinery', () => {
    expect(route).toContain("router.post('/projects/:projectId/credentials/:credentialId/reveal'");
    expect(route).not.toMatch(/compareCredential|reveal-challenges|\/compare'/);
    expect(service).toContain("eventType: 'credential_revealed'");
  });

  it('keeps normal lists and structure inspection secret-free', () => {
    expect(route).toContain('rawValueAvailable: false');
    expect(route).toContain("res.setHeader('Cache-Control', 'no-store, private')");
    expect(route).toContain('secret_name: _secretName');
  });
});
