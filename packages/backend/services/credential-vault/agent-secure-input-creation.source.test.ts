import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const backendRoot = path.resolve(import.meta.dirname, '../..');
const route = fs.readFileSync(path.join(backendRoot, 'routes/credential-vault-api.ts'), 'utf8');
const ui = fs.readFileSync(path.join(backendRoot, '../frontend/src/components/chat/SecureInputBlock.tsx'), 'utf8');

describe('Agent secure input credential creation contract', () => {
  it('authorizes the current Agent manager and creates a project-scoped Credential', () => {
    expect(route).toContain("router.post('/projects/:projectId/credentials/api-key'");
    expect(route).toContain('await assertProjectConnectionManager(req, projectId)');
    expect(route).toContain("scope: 'project'");
    expect(route).toContain("connection_type: 'agent'");
    expect(route).toContain('agent_project_id: projectId');
  });

  it('binds the Credential to the Agent before returning success', () => {
    const endpoint = route.slice(route.indexOf("router.post('/projects/:projectId/credentials/api-key'"), route.indexOf("router.post('/credentials/ssh-private-key'"));
    expect(endpoint).toContain('await upsertApiKeyCredential');
    expect(endpoint).toContain('await setProjectCredentialPolicy');
    expect(endpoint).toContain("mode: 'allow'");
    expect(endpoint).toContain("created_via: 'secure_input'");
    expect(endpoint).toContain("eventType: 'agent_binding_failed'");
    expect(endpoint.indexOf('await setProjectCredentialPolicy')).toBeLessThan(endpoint.indexOf('res.json'));
  });

  it('returns no secret value or secret name', () => {
    const endpoint = route.slice(route.indexOf("router.post('/projects/:projectId/credentials/api-key'"), route.indexOf("router.post('/credentials/ssh-private-key'"));
    expect(endpoint).toContain('value: undefined, secret_name: undefined');
    expect(endpoint).not.toContain('secretValue: rawSecretValue,');
    expect(endpoint).not.toContain('secretValue: credential.');
  });

  it('lets the Agent initiate secure self-registration for its current project without seeing the secret', () => {
    expect(ui).toContain("scope: own.scope || base.scope || 'project'");
    expect(ui).toContain('base.grantToCurrentProject ?? true');
    expect(ui).toContain('/credentials/api-key`');
    expect(ui).toContain("credential.scope !== 'project'");
    expect(ui).toContain("t('credentialSavedForCurrentAgent'");
    expect(ui).toContain('type="password"');
    expect(ui).toContain('setValues(prev => Object.fromEntries');
    expect(ui).not.toContain('console.log(value');
  });
});
