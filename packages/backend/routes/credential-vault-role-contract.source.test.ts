import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const route = readFileSync(new URL('./credential-vault-api.ts', import.meta.url), 'utf8');

describe('Credential Vault role contract', () => {
  it('keeps team list visible to admin/operator and team mutations company-managed', () => {
    expect(route).toContain("router.get('/credentials'");
    expect(route).toContain('const allowed = assertOperator(req)');
    expect(route).toContain("router.post('/credentials/api-key'");
    expect(route.match(/const allowed = assertOperator\(req\)/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('delegates Agent Credential lifecycle to Agent managers', () => {
    expect(route.match(/assertProjectConnectionManager\(req, projectId\)/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it('allows explicit Agent reveal without restoring challenge or compare APIs', () => {
    expect(route).toContain("router.post('/projects/:projectId/credentials/:credentialId/reveal'");
    expect(route).toContain('assertProjectConnectionManager(req, projectId)');
    expect(route).toContain('revealCredentialValue({');
    expect(route).not.toMatch(/compareCredential|reveal-challenges|\/compare'/);
  });
});
