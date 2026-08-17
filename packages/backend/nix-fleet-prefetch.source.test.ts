import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
const restore = read('scripts/nix-supply-chain/restore-operator-cache-azure');
const fleet = read('scripts/fleet/fleet-nix-prefetch.sh');

describe('Nix S3 prefetch transport source contract', () => {
  it('restores only public cache state and verifies it before use', () => {
    expect(restore).toContain('refusing to overwrite live cache');
    expect(restore).toContain('download-batch');
    expect(restore).toContain('promotion-ledger.json');
    expect(restore).toContain('--sigs-needed 1');
    expect(restore).toContain('runtimeBoxArtifactsVerified":true');
    expect(restore).toContain('Runtime Box archive verification failed');
    expect(restore).toContain('privateKeyRestored":false');
    expect(restore).not.toContain('tower-cache-1.sec');
  });

  it('defaults to plan mode and requires exact sourceRev acknowledgement for apply', () => {
    expect(fleet).toContain('Default is read-only planning');
    expect(fleet).toContain('(( apply )) || exit 0');
    expect(fleet).toContain('--ack must equal sourceRev');
    expect(fleet).toContain('sourceRev/storePath is not in promotion ledger');
    expect(fleet).toContain("row.get('runtimeBoxArtifactFingerprint')");
    expect(fleet).toContain("data.get('runtimeBoxArtifacts')");
    expect(fleet).toContain('remote Runtime Box archive hash mismatch');
    expect(fleet).toContain('runtime_archive_transfer="reused"');
    expect(fleet).toContain('uploaded Runtime Box archive hash mismatch');
    expect(fleet.indexOf('REMOTE_CHECK')).toBeLessThan(fleet.indexOf('"$runtime_archive" "$ssh_target:$runtime_archive_tmp"'));
    expect(fleet).toContain("'archiveTransfer':archive_transfer");
    expect(fleet).toContain('docker load');
    expect(fleet).toContain('runtime-box-candidate-${source_rev}.json');
    expect(fleet).not.toContain("u={'RUNTIME_BOX_IMAGE'");
  });

  it('prefetches to a candidate root without touching production service, current/previous semantics or DB', () => {
    expect(fleet).toContain('sudo ~/.tower-nix-cache/bin/prefetch-signed-closure');
    expect(fleet).toContain('trusted-public-keys is a restricted daemon setting');
    expect(fleet).toContain('manage-customer-generations prepare');
    expect(fleet).toContain('creates a candidate GC root without changing current/previous production semantics');
    expect(fleet).toContain('mutatesService":false');
    expect(fleet).toContain('mutatesDatabase":false');
    expect(fleet).not.toContain('manage-customer-generations promote');
    expect(fleet).not.toContain('pm2 stop');
    expect(fleet).not.toContain('pm2 restart');
    expect(fleet).not.toContain('cutover-production');
  });
});
