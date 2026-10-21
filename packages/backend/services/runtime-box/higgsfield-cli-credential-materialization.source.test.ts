import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const managerPath = path.join(process.cwd(), 'packages/backend/services/runtime-box/runtime-box-manager.ts');
const source = fs.readFileSync(managerPath, 'utf8');

describe('Higgsfield CLI persistent session contract', () => {
  it('detects top-level Higgsfield CLI commands and enters CLI preparation', () => {
    expect(source).toContain("commandNeedsTool(req.cmd, 'higgsfield')");
    expect(source).toContain('!needsGh && !needsAz && !needsGws && !needsHiggsfield');
    expect(source).toContain('prepareHiggsfieldPersistentSession');
  });

  it('uses an Agent-project persistent service home by default', () => {
    expect(source).toContain("'/workspace/.tower/service-home/higgsfield/.config/higgsfield/credentials.json'");
    expect(source).toContain("'/workspace/.tower/service-home/higgsfield'");
    expect(source).toContain("credentialId: 'project-managed:higgsfield-session'");
  });

  it('allows an explicit project-managed credential file path', () => {
    expect(source).toContain('opts.env.HIGGSFIELD_CLI_CREDENTIALS_FILE');
    expect(source).toContain('const credentialsPath = configuredPath ||');
    expect(source).toContain('opts.env.HIGGSFIELD_CLI_CREDENTIALS_FILE = credentialsPath');
  });

  it('does not recreate the OAuth JSON from Vault or delete the persistent session after a command', () => {
    const persistentBlock = source.slice(
      source.indexOf('async function prepareHiggsfieldPersistentSession'),
      source.indexOf('async function materializeRuntimeCredentialFiles'),
    );
    expect(persistentBlock).not.toContain('resolveProjectCredentialSecretValue');
    expect(persistentBlock).not.toContain('writeCredentialFileFromString');
    expect(persistentBlock).not.toContain('rm -rf');
  });

  it('retains command-finally cleanup only for temporary Vault materialization roots', () => {
    expect(source).toContain('await dockerExecShell(containerRef, `rm -rf ${shellQuote(credentialRoot)}`, 10_000);');
  });
});
