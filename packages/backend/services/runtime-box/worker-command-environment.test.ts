import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inheritWorkerCommandEnvironment } from './worker-command-environment.js';

describe('Worker command baseline environment', () => {
  it('preserves module resolution and CA paths without inheriting secrets or arbitrary Node flags', () => {
    const baseline = {
      LANG: 'C.UTF-8', NODE_PATH: '/nix/store/example-tools/node_modules',
      SSL_CERT_FILE: '/nix/store/example-ca/etc/ssl/certs/ca-bundle.crt',
      NODE_EXTRA_CA_CERTS: '/nix/store/example-ca/etc/ssl/certs/ca-bundle.crt',
      NIX_SSL_CERT_FILE: '/nix/store/example-ca/etc/ssl/certs/ca-bundle.crt',
    };
    expect(inheritWorkerCommandEnvironment({ ...baseline,
      API_KEY: 'synthetic-test-value', NODE_OPTIONS: '--require=untrusted.js',
      NODE_TLS_REJECT_UNAUTHORIZED: '0', HTTPS_PROXY: 'synthetic-proxy',
    })).toEqual(baseline);
  });

  it('does not manufacture values for host Workers without a configured baseline', () => {
    expect(inheritWorkerCommandEnvironment({ NODE_PATH: '', SSL_CERT_FILE: undefined })).toEqual({});
  });

  it('provides identical immutable trust bundles to the Nix Worker and doctor', () => {
    const flake = fs.readFileSync(path.join(process.cwd(), 'flake.nix'), 'utf8');
    for (const binary of ['tower-workbench-worker', 'runtime-compute-doctor']) {
      const wrapper = flake.split(`wrapProgram "$out/bin/${binary}"`)[1].split('wrapProgram ')[0];
      for (const key of ['SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'NIX_SSL_CERT_FILE']) {
        expect(wrapper).toContain(`--set ${key} "\${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"`);
      }
    }
  });

  it('gives the GWS executable its own default trust bundle, independent of Worker env', () => {
    const flake = fs.readFileSync(path.join(process.cwd(), 'flake.nix'), 'utf8');
    const gws = flake.split('workerGws = pkgs.stdenv.mkDerivation')[1].split('workerPublishingTools =')[0];
    expect(gws).toContain('pkgs.makeWrapper');
    expect(gws).toContain('wrapProgram "$out/bin/gws"');
    expect(gws).toContain('--set-default SSL_CERT_FILE "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"');
    expect(gws).not.toContain('SSL_VERIFY=false');
  });

  it('uses the allowlisted environment in the execution path and retains the immutable store mount', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'packages/backend/services/execution/worker/worker-server.ts'), 'utf8');
    expect(source).toContain('const inheritedEnv = inheritWorkerCommandEnvironment(process.env)');
    expect(source).toContain("'--ro-bind-try', '/nix/store', '/nix/store'");
    expect(source).not.toContain("'--ro-bind', '/etc', '/etc'");
  });
});
