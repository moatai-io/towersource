import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const resolver = fs.readFileSync(path.join(root, 'packages/backend/services/runtime-box/workbench-remote-credential-resolution.ts'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'packages/backend/services/execution/worker/worker-server.ts'), 'utf8');

describe('Higgsfield Remote Worker materialization contract', () => {
  it('resolves the OAuth credential through project policy into an internal envelope key', () => {
    expect(resolver).toContain("credentialId: 'higgsfield-cli-oauth'");
    expect(resolver).toContain("targetType: 'remote_worker_higgsfield_cli_config'");
    expect(resolver).toContain('env.TOWER_REMOTE_HIGGSFIELD_CREDENTIALS_JSON = higgsfield.value');
  });

  it('validates and writes credentials.json with private permissions', () => {
    expect(worker).toContain('materializeRemoteHiggsfield');
    expect(worker).toContain('!parsed.access_token || !parsed.refresh_token');
    expect(worker).toContain("path.join(home, '.config', 'higgsfield')");
    expect(worker).toContain("path.join(configDir, 'credentials.json')");
    expect(worker).toContain("fs.writeFile(credentialsPath, raw, { mode: 0o600 })");
  });

  it('removes the internal envelope value before process execution', () => {
    expect(worker).toContain('delete processCredentials.TOWER_REMOTE_HIGGSFIELD_CREDENTIALS_JSON');
    expect(worker).toContain('HIGGSFIELD_CLI_CREDENTIALS_FILE: credentialsPath');
  });

  it('cleans up every temporary Credential root and reports file materialization without the secret', () => {
    expect(worker).toContain('Promise.allSettled([files.cleanup(), gws.cleanup(), higgsfield.cleanup()])');
    expect(worker).toContain("...(higgsfield.materialized ? ['HIGGSFIELD_CLI_CREDENTIALS_FILE'] : [])");
    expect(worker).toContain("env_name: envName, kind: 'file' as const");
  });
});
