import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const route = readFileSync(new URL('../../routes/credential-vault-api.ts', import.meta.url), 'utf8');
const service = readFileSync(new URL('./credential-vault-service.ts', import.meta.url), 'utf8');

describe('team-shared Credential lifecycle contract', () => {
  it('requires a company manager for create, rotate, enable-disable, and delete', () => {
    expect(route).toContain("router.post('/credentials/api-key'");
    expect(route).toContain("router.post('/credentials/:credentialId/rotate'");
    expect(route).toContain("router.patch('/credentials/:credentialId'");
    expect(route).toContain("router.delete('/credentials/:credentialId'");
    expect(route.match(/assertOperator\(req\)/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('applies workspace scope atomically instead of using disconnect policies', () => {
    expect(route).toContain("scope: 'workspace'");
    expect(service).toContain('enabled = COALESCE($2, enabled)');
    expect(route).not.toMatch(/project_credential_policies|lifecycle|disconnect|restore/);
  });
});
