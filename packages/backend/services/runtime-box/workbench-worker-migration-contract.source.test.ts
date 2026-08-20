import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const worker = fs.readFileSync(path.join(root, 'packages/backend/services/runtime-box/remote-workbench-worker-server.ts'), 'utf8');
const credentials = fs.readFileSync(path.join(root, 'packages/backend/services/runtime-box/workbench-remote-credential-resolution.ts'), 'utf8');
const flake = fs.readFileSync(path.join(root, 'flake.nix'), 'utf8');

describe('Project Workstation migration contract', () => {
  it('keeps the authoritative document/PDF toolchain in the Worker closure', () => {
    for (const expected of ['pkgs.typst', 'workerPandoc', 'workerMermaid', 'pkgs.libreoffice-fresh', 'pkgs.chromium', 'pkgs.poppler-utils']) {
      expect(flake).toContain(expected);
    }
  });

  it('uses a native host shell that starts in the Project directory', () => {
    expect(worker).toContain("spawn('setsid', ['--wait', 'sh', '-c', spec.command]");
    expect(worker).toContain('cwd,');
    expect(worker).toContain("TOWER_WORKSTATION_SHELL: 'native'");
    expect(worker).toContain('HOME: process.env.HOME || projectRoot');
    expect(worker).not.toContain('WORKER_BWRAP_REQUIRED');
  });

  it('keeps /workspace and registered projections as logical cwd aliases', () => {
    expect(worker).toContain("cwd === projectRoot ? '/workspace'");
    expect(worker).toContain('cwd escapes registered projection');
    expect(worker).toContain('default_scope: \'current-project\'');
    expect(worker).toContain('host_tools: \'available\'');
  });

  it('selects command-scoped Credential env instead of injecting every Project grant', () => {
    expect(credentials).toContain('requestedCredentialEnvNames');
    expect(credentials).toContain('filterCredentialEnv');
    expect(credentials).toContain('const selectedApiEnv');
    expect(credentials).toContain('requestedFiles');
  });
});
