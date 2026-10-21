import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const route = readFileSync(new URL('../../routes/credential-vault-api.ts', import.meta.url), 'utf8');
const reliability = readFileSync(new URL('./connection-reliability.ts', import.meta.url), 'utf8');

describe('Connection diagnostics contract', () => {
  it('removes provider probe mutation routes and policy gates', () => {
    expect(route).not.toMatch(/\/probe'|probeConnection|project_credential_policies|credential_profiles/);
  });

  it('keeps secret-free Agent catalog and status diagnostics', () => {
    expect(route).toContain("router.get('/projects/:projectId/connections/catalog'");
    expect(reliability).toContain('diagnoseProjectConnectionStatus');
    expect(reliability).not.toContain('runtime.env');
  });
});
