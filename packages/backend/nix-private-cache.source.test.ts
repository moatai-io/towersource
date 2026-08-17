import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => fs.readFileSync(path.join(process.cwd(), 'scripts/nix-supply-chain', name), 'utf8');
const install = read('install-operator-nginx-cache');
const publish = read('publish-operator-cache');

describe('Nix private HTTPS cache S2 source contract', () => {
  it('keeps official signing state root-only outside app and workspace paths', () => {
    expect(install).toContain('key_dir="/var/lib/tower-nix-signing"');
    expect(install).toContain('install -d -m 0700 -o root -g root "$key_dir"');
    expect(install).toContain('chmod 0600 "$key_file"');
    expect(install).toContain('chmod 0644 "$ledger"');
    expect(install).toContain('root required');
    expect(install).not.toContain('.env');
  });

  it('serves an HTTPS read-only cache to an explicit IP allowlist', () => {
    expect(install).toContain('server_name $server_name');
    expect(install).toContain('ssl_protocols TLSv1.2 TLSv1.3');
    expect(install).toContain('allow $ip;');
    expect(install).toContain('if (\\$realip_remote_addr != \\$remote_addr) { return 403; }');
    expect(install).toContain('deny all;');
    expect(install).toContain('limit_except GET HEAD { deny all; }');
    expect(install).toContain('try_files \\$uri =404;');
    expect(install).toContain('[[ -e "$site_enabled" && ! -L "$site_enabled" ]]');
    expect(install).toContain('ln -sfn "$site_available" "$site_enabled"');
    expect(install).toContain('readlink -f "$site_enabled"');
    expect(install).toContain('nginx -t');
  });

  it('uses the S1 signed publisher without signature bypass flags', () => {
    expect(publish).toContain('/var/lib/tower-nix-cache');
    expect(publish).toContain('/var/lib/tower-nix-signing/tower-cache-1.sec');
    expect(publish).toContain('publish-signed-file-cache');
    expect(publish).not.toContain('--no-check-sigs');
    expect(publish).not.toContain('require-sigs = false');
  });
});
