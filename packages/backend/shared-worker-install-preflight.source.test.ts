import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../scripts/nix-app/tower-shared-worker-install-preflight', import.meta.url), 'utf8');
const flake = readFileSync(new URL('../../flake.nix', import.meta.url), 'utf8');

describe('shared Worker installation preflight', () => {
  it('checks every Fleet prerequisite without mutating the host', () => {
    for (const check of [
      '/nix/var/nix/profiles/default/bin/nix',
      'nix-cache-info',
      'getfacl',
      'setfacl',
      'tower-worker-permission-preflight',
      'chromium',
      'google-chrome-stable',
      'bwrap',
      'kernel.apparmor_restrict_unprivileged_userns',
      'kernel.unprivileged_userns_clone',
      'user.max_user_namespaces',
      'SECRET_STORE_MASTER_KEY',
    ]) expect(source).toContain(check);
    expect(source).toContain("'mutated':False");
    for (const mutation of ['apt-get', 'setfacl -m', 'sysctl -w', 'ln -s', 'openssl rand', 'systemctl restart']) {
      expect(source).not.toContain(mutation);
    }
  });

  it('tests bubblewrap before interpreting AppArmor and never prints the master key', () => {
    const smoke = source.indexOf('--unshare-user --uid 0 --gid 0 true');
    const apparmor = source.indexOf('kernel.apparmor_restrict_unprivileged_userns');
    expect(smoke).toBeGreaterThan(0);
    expect(smoke).toBeLessThan(apparmor);
    expect(source).toContain("grep -q '^SECRET_STORE_MASTER_KEY=.'");
    expect(source).not.toContain('source "$env_file"');
    expect(source).not.toContain('cat "$env_file"');
  });

  it('is shipped inside the immutable Tower closure with required diagnostic tools', () => {
    expect(flake).toContain('tower-shared-worker-install-preflight');
    expect(flake).toContain('tower-shared-worker-host-policy');
    expect(flake).toContain('pkgs.curl pkgs.acl pkgs.shadow pkgs.util-linux pkgs.python3');
  });
});
