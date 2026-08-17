import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const route = readFileSync(new URL('../../routes/credential-vault-api.ts', import.meta.url), 'utf8');

describe('Connection probe route contract', () => {
  it('requires Agent manager access and an allowed project binding', () => {
    expect(route).toContain("router.post('/connections/:connectionId/projects/:projectId/probe'");
    expect(route).toContain('const allowed = await assertProjectConnectionManager(req, projectId)');
    expect(route).toContain("p.mode IN ('allow', 'override', 'inherit')");
    expect(route).toContain("p.mode IS NULL AND c.scope IN ('workspace', 'internal-default')");
    expect(route).toContain("pp.mode = 'allow'");
    expect(route).toContain("WHERE wc.scope = 'personal'");
  });

  it('delegates to the secret-safe provider probe without accepting a browser secret', () => {
    expect(route).toContain('res.json(await probeConnection({');
    expect(route).not.toContain('probeConnection({ secret');
    expect(route).toContain("code: 'PROJECT_ACCESS_REQUIRED'");
  });
});
