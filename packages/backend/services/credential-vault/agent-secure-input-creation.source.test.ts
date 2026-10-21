import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const route = readFileSync(new URL('../../routes/credential-vault-api.ts', import.meta.url), 'utf8');
const tool = readFileSync(new URL('../../engines/pi-credential-vault-tool.ts', import.meta.url), 'utf8');

describe('Agent secure input credential creation contract', () => {
  it('creates one project Credential directly under Agent manager authority', () => {
    expect(route).toContain("router.post('/projects/:projectId/credentials/api-key'");
    expect(route).toContain("scope: 'project', projectId");
    expect(route).not.toContain('setProjectCredentialPolicy');
  });

  it('never returns the raw secret or storage secret name from creation endpoints', () => {
    expect(route).toContain('publicCredential(credential)');
    expect(route).toContain('secret_name: _secretName');
    expect(route).toContain('res.json({ credential: publicCredential(credential)');
  });

  it('offers only project and workspace secure input scopes', () => {
    expect(tool).toContain("Type.Literal('project')");
    expect(tool).toContain("Type.Literal('workspace')");
    expect(tool).not.toContain("Type.Literal('personal')");
    expect(tool).not.toContain('grantToCurrentProject');
  });
});
