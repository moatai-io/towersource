import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const route = readFileSync(new URL('../../routes/credential-vault-api.ts', import.meta.url), 'utf8');

describe('simplified Agent Connection catalog contract', () => {
  it('authorizes Agent managers once for credential and catalog operations', () => {
    expect(route).toContain('async function assertProjectConnectionManager');
    expect(route).toContain("['owner', 'admin', 'member'].includes(rows[0].membership_role ?? '')");
  });

  it('catalogs team-shared automatic and current-Agent dedicated credentials only', () => {
    expect(route).toContain("allowedProjectCredentialWhere('c', '$1')");
    expect(route).toContain("connectionScope: row.scope === 'workspace' ? 'team_shared' : 'agent_dedicated'");
    expect(route).toContain("automatic: row.scope === 'workspace'");
  });

  it('has no grant/default/intent/challenge/compare/target-sync route surface', () => {
    expect(route).not.toMatch(/project-policies|connection-defaults|\/preview'|\/apply'|reveal-challenges|\/compare'|\/targets/);
    expect(route).not.toMatch(/credential_profiles|workspace_connection_defaults|credential_connection_change_intents|credential_target_syncs/);
  });
});
