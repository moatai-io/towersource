import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const manager = readFileSync(new URL('./runtime-box-manager.ts', import.meta.url), 'utf8');
const reliability = readFileSync(new URL('../credential-vault/connection-reliability.ts', import.meta.url), 'utf8');

describe('Agent-bound GWS Connection selection contract', () => {
  it('lists all allowed Google Workspace Connections with non-secret routing metadata', () => {
    expect(manager).toContain('listAllowedProjectGwsConnections');
    expect(manager).toContain("c.kind = 'gws'");
    expect(manager).toContain("c.provider = 'google'");
    expect(manager).toContain("c.scope = 'workspace'");
    expect(manager).toContain("c.scope = 'project' AND c.project_id = $1");
    expect(manager).toContain('credential_type_id');
    expect(manager).toContain('google_account');
    expect(manager).not.toContain('project_credential_policies');
  });

  it('selects an explicit allowed Connection, auto-selects a sole safe default, and asks on ambiguity', () => {
    expect(manager).toContain('const requestedCredentialId = commandRequestsGwsConnectionId(opts.command)');
    expect(manager).toContain('requestedCredentialId,');
    expect(manager).toContain("const projectRows = rows.filter(row => row.scope === 'project')");
    expect(manager).toContain("row.scope === 'project' && projectRows.length === 1");
    expect(manager).toContain('const projectDefaults = candidates.filter(candidate => candidate.isProjectDefault)');
    expect(manager).toContain('if (projectDefaults.length === 1) return projectDefaults[0]');
    expect(manager).toContain('if (candidates.length === 1) return candidates[0]');
    expect(manager).toContain('AMBIGUOUS_GWS_CONNECTION');
    expect(manager).toContain('Ask the user which account or purpose to use');
    expect(manager).toContain('GWS_CONNECTION_ID=<id>');
    expect(manager).toContain('GWS_CONNECTION_NOT_ALLOWED');
  });

  it('materializes only the selected GWS Credential instead of a hard-coded default', () => {
    expect(manager).toContain('credentialId: selected.id');
    expect(manager).not.toContain("credentialId: GWS_VAULT_CREDENTIAL_ID");
    expect(manager).not.toContain('allow gws-default-config');
  });

  it('keeps connection_status secret-free across complete team/Agent inventory', () => {
    expect(reliability).toContain("coverage: 'team-shared-and-agent-dedicated'");
    expect(reliability).toContain("row.provider");
    expect(reliability).not.toContain('resolved.value');
  });
});
