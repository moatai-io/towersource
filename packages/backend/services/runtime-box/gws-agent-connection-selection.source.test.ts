import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const manager = readFileSync(new URL('./runtime-box-manager.ts', import.meta.url), 'utf8');
const reliability = readFileSync(new URL('../credential-vault/connection-reliability.ts', import.meta.url), 'utf8');

describe('Agent-bound GWS Connection selection contract', () => {
  it('lists all allowed Google Workspace Connections for the current Agent', () => {
    expect(manager).toContain('listAllowedProjectGwsConnections');
    expect(manager).toContain("c.kind = 'gws'");
    expect(manager).toContain("c.provider = 'google'");
    expect(manager).toContain("p.mode IN ('allow', 'override', 'inherit')");
    expect(manager).toContain("p.metadata->>'runtime_default'");
  });

  it('selects an explicit allowed Connection, auto-selects a sole candidate, and fails closed on ambiguity', () => {
    expect(manager).toContain('const requestedCredentialId = commandRequestsGwsConnectionId(opts.command)');
    expect(manager).toContain('requestedCredentialId,');
    expect(manager).toContain('const projectDefaults = candidates.filter(candidate => candidate.isProjectDefault)');
    expect(manager).toContain('if (projectDefaults.length === 1) return projectDefaults[0]');
    expect(manager).toContain('AMBIGUOUS_GWS_DEFAULT');
    expect(manager).toContain('if (candidates.length === 1) return candidates[0]');
    expect(manager).toContain('AMBIGUOUS_GWS_CONNECTION');
    expect(manager).toContain('GWS_CONNECTION_ID=<id>');
    expect(manager).toContain('GWS_CONNECTION_NOT_ALLOWED');
  });

  it('materializes only the selected GWS Credential instead of a hard-coded default', () => {
    expect(manager).toContain('credentialId: selected.id');
    expect(manager).not.toContain("credentialId: GWS_VAULT_CREDENTIAL_ID");
    expect(manager).not.toContain('allow gws-default-config');
  });

  it('keeps connection_status secret-free without coupling selection to one inventory implementation', () => {
    expect(reliability).toContain("capability: 'google_workspace'");
    expect(reliability).toMatch(/coverage: 'known-and-agent-bound(?:-api-keys)?'/);
    expect(reliability).not.toContain('resolved.value');
  });
});
