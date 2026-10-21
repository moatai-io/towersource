import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const broker = readFileSync(new URL('../execution/execution-broker.ts', import.meta.url), 'utf8');
const transport = readFileSync(new URL('../execution/worker/worker-http-transport.ts', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../execution/worker/worker-server.ts', import.meta.url), 'utf8');
const local = readFileSync(new URL('./runtime-box-manager.ts', import.meta.url), 'utf8');
const remoteCredentials = readFileSync(new URL('./workbench-remote-credential-resolution.ts', import.meta.url), 'utf8');
const vault = readFileSync(new URL('../credential-vault/credential-vault-service.ts', import.meta.url), 'utf8');

describe('Local Runtime and Remote Worker authority parity', () => {
  it('authorizes worker execution in the control plane before provider dispatch', () => {
    expect(broker).toContain("resource: 'worker'");
    expect(broker).toContain("action: 'execute'");
    expect(broker).toContain('WORKBENCH_EXECUTION_DENIED');
  });

  it('binds every Remote Worker run to a signed, scoped, expiring receipt', () => {
    expect(transport).toContain('issueWorkbenchAuthorizationReceipt({');
    expect(transport).toContain('authorizationReceipt: receipt');
    expect(worker).toContain('verifyWorkbenchAuthorizationReceipt({');
    expect(worker).toContain('authorization receipt was already consumed');
    expect(worker).not.toMatch(/actorUserId[^\n]*role/);
  });

  it('uses one command-scope vocabulary before API-key and file secret resolution in both planes', () => {
    expect(local).toContain("requestedCredentialEnvNames(req.cmd)");
    expect(local.match(/requestedEnvNames: requestedCredentialScope/g)?.length).toBeGreaterThanOrEqual(2);
    expect(remoteCredentials).toContain("requestedCredentialEnvNames(input.request.command)");
    expect(remoteCredentials.match(/requestedEnvNames: requested/g)?.length).toBeGreaterThanOrEqual(2);
    expect(remoteCredentials).toContain('TOWER_REMOTE_FILE_CREDENTIAL_');
    expect(worker).toContain('materializeRemoteFileCredentials');
    expect(worker).toContain('cleanupStaleRunCredentials');
    expect(vault.match(/not requested by command credential scope/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
