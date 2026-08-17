import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => fs.readFileSync(path.join(process.cwd(), 'scripts/nix-supply-chain', name), 'utf8');
const generations = read('manage-customer-generations');
const rotation = read('rehearse-key-rotation');
const mirror = read('mirror-operator-cache-azure');
const keyBackup = read('backup-signing-key-gpg');

describe('Nix cache recovery contracts', () => {
  it('separates prepared candidates from current and previous production roots', () => {
    expect(generations).toContain('manage-customer-generations prepare');
    expect(generations).toContain('--add-root "$candidate_root" -r "$candidate"');
    expect(generations).toContain('--add-root "$previous" -r "$old_current"');
    expect(generations).toContain('--add-root "$current" -r "$candidate"');
    expect(generations).toContain('actual cutover has verified the candidate as production');
    expect(generations).toContain('candidate is not realized locally');
    expect(generations).not.toContain('pm2');
    expect(generations).not.toContain('systemctl');
  });

  it('rehearses overlap and models revocation as removing old client trust', () => {
    expect(rotation).toContain('--trusted-public-keys "$pub1 $pub2"');
    expect(rotation).toContain('--trusted-public-keys "$pub2"');
    expect(rotation).toContain('remove-old-from-client-trust');
    expect(rotation).toContain('untrusted key unexpectedly accepted');
  });

  it('requires an existing full-fingerprint offline recipient before encrypting a private-key backup', () => {
    expect(keyBackup).toContain('full 40-hex fingerprint required');
    expect(keyBackup).toContain('exact offline recipient not found');
    expect(keyBackup).toContain('encrypted backup must not be written to repo/workspace');
    expect(keyBackup).toContain('plaintextUploaded":false');
    expect(keyBackup).not.toContain('generate-key');
    expect(keyBackup).not.toContain('quick-generate-key');
  });

  it('incrementally mirrors immutable cache objects and the mutable ledger off-host', () => {
    expect(mirror).toContain("--prefix \"$prefix/cache/\"");
    expect(mirror).toContain("if prefix+rel not in remote: missing.append(rel)");
    expect(mirror).toContain("--if-none-match '*'");
    expect(mirror).toContain('"mode":"incremental"');
    expect(mirror).toContain('uploadedCacheObjects');
    expect(mirror).toContain("rows[-1].get('runtimeBoxArtifactFingerprint')");
    expect(mirror).toContain("x['mirrorObject']");
    expect(mirror).toContain('--metadata sha256="$archive_sha"');
    expect(mirror).toContain('Runtime Box remote object verification failed');
    expect(mirror.indexOf('Runtime Box remote object verification failed')).toBeLessThan(mirror.lastIndexOf('promotion-ledger.json'));
    expect(mirror).not.toContain('az storage blob upload-batch');
    expect(mirror).toContain('promotion-ledger.json');
    expect(mirror).toContain('privateKeyIncluded":false');
    expect(mirror).not.toContain('tower-cache-1.sec');
    expect(mirror).not.toContain('AZURE_STORAGE_KEY');
  });
});
