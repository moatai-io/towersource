import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const backendRoot = path.resolve(import.meta.dirname, '../..');
const route = fs.readFileSync(path.join(backendRoot, 'routes/credential-vault-api.ts'), 'utf8');

describe('Agent-owned Credential management API contract', () => {
  it('lists only project-scoped credentials explicitly owned by the current Agent', () => {
    const endpoint = route.slice(route.indexOf("router.get('/projects/:projectId/credentials'"), route.indexOf("router.post('/projects/:projectId/credentials/api-key'"));
    expect(endpoint).toContain('await assertProjectConnectionManager(req, projectId)');
    expect(endpoint).toContain("c.scope = 'project'");
    expect(endpoint).toContain("c.metadata->>'connection_type' = 'agent'");
    expect(endpoint).toContain("c.metadata->>'agent_project_id' = $1");
    expect(endpoint).not.toContain('secret_name');
    expect(endpoint).not.toContain('getSecret');
  });

  it('allows structure inspection without returning raw secret data', () => {
    const endpoint = route.slice(route.indexOf("router.post('/projects/:projectId/credentials/:credentialId/inspect'"), route.indexOf("router.post('/projects/:projectId/credentials/:credentialId/rotate'"));
    expect(endpoint).toContain('await assertProjectConnectionManager(req, projectId)');
    expect(endpoint).toContain("metadata->>'agent_project_id' = $2");
    expect(endpoint).toContain('inspectCredential');
    expect(endpoint).not.toContain('revealCredentialFieldAsAdmin');
  });

  it('rotates only credentials owned by the current Agent and never echoes the value', () => {
    const endpoint = route.slice(route.indexOf("router.post('/projects/:projectId/credentials/:credentialId/rotate'"), route.indexOf("router.post('/credentials/ssh-private-key'"));
    expect(endpoint).toContain('await assertProjectConnectionManager(req, projectId)');
    expect(endpoint).toContain("metadata->>'connection_type' = 'agent'");
    expect(endpoint).toContain("metadata->>'agent_project_id' = $2");
    expect(endpoint).toContain('rotateExistingCredential');
    expect(endpoint).toContain('value: undefined, secret_name: undefined');
    expect(endpoint).not.toContain('secretValue: credential.');
  });
});
