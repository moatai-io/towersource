import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const route = fs.readFileSync(path.resolve(import.meta.dirname, '../../routes/credential-vault-api.ts'), 'utf8');

describe('Agent Credential management API contract', () => {
  it('lists only project credentials owned by project_id', () => {
    expect(route).toContain("listWorkspaceCredentials({ scope: 'project', projectId })");
    expect(route).not.toContain('project_credential_policies');
  });

  it('keeps structure inspection secret-free while offering an audited trusted reveal route', () => {
    expect(route).toContain('rawValueAvailable: false');
    expect(route).toContain("router.post('/projects/:projectId/credentials/:credentialId/reveal'");
    expect(route).not.toMatch(/compareCredentialField|reveal-challenges/);
  });

  it('supports create, rotate, enable-disable, and delete under Agent manager authority', () => {
    expect(route).toContain("router.post('/projects/:projectId/credentials/api-key'");
    expect(route).toContain("router.post('/projects/:projectId/credentials/:credentialId/rotate'");
    expect(route).toContain("router.patch('/projects/:projectId/credentials/:credentialId'");
    expect(route).toContain("router.delete('/projects/:projectId/credentials/:credentialId'");
    expect(route.match(/assertProjectConnectionManager\(req, projectId\)/g)?.length).toBeGreaterThanOrEqual(6);
  });
});
