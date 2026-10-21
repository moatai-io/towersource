import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const route = fs.readFileSync(path.join(import.meta.dirname, '../../routes/credential-vault-api.ts'), 'utf8');
const service = fs.readFileSync(path.join(import.meta.dirname, 'credential-vault-service.ts'), 'utf8');

describe('Admin VM Vault contract', () => {
  it('exposes secret-free inventory, orphan diagnostics, and bounded audit history to operators', () => {
    const block = route.slice(route.indexOf("router.get('/admin-overview'"), route.indexOf("router.post('/admin/credentials"));
    expect(block).toContain('assertOperator(req)');
    expect(block).toContain("(p.id IS NULL AND c.scope = 'project') AS orphaned");
    expect(block).toContain("COALESCE(NULLIF(pap.display_name, ''), p.name) AS project_name");
    expect(block).not.toContain('p.slug');
    expect(block).toContain('FROM credential_audit_events a');
    expect(block).toContain('LIMIT 100');
    expect(block).not.toContain('secret_name');
    expect(block).not.toContain('getSecret');
  });

  it('requires company manager and exact project ownership when promoting an Agent Credential', () => {
    const routeBlock = route.slice(route.indexOf("router.post('/admin/credentials/:credentialId/promote'"), route.indexOf('// Team-shared Credentials'));
    expect(routeBlock).toContain('assertOperator(req)');
    expect(routeBlock).toContain("projectId: bodyString(req, 'projectId')!");

    const serviceBlock = service.slice(service.indexOf('export async function promoteProjectCredentialToWorkspace'), service.indexOf('export async function updateCredentialLifecycle'));
    expect(serviceBlock).toContain("SET scope = 'workspace', project_id = NULL");
    expect(serviceBlock).toContain("WHERE id = $1 AND scope = 'project' AND project_id = $2");
    expect(serviceBlock).toContain("eventType: 'credential_promoted_to_workspace'");
  });
});
