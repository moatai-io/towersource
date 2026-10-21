import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const prepare = readFileSync('scripts/oss/prepare-ops-archive.sh', 'utf8');
const remove = readFileSync('scripts/oss/remove-ops-materials.sh', 'utf8');

describe('private operations archive safety contract', () => {
  it('writes a machine-readable verification record after checksum and restore validation', () => {
    expect(prepare).toContain('--manifest FILE');
    expect(prepare).toContain('--record FILE');
    expect(prepare).toContain("'archiveSha256Sums': 'passed'");
    expect(prepare).toContain("'tarballRestoreSmoke': restore");
    expect(prepare).toContain("'envOrCredentialFilenameEntriesInTar': int(sensitive)");
  });

  it('refuses to create a verified archive record for an empty manifest expansion', () => {
    expect(prepare).toContain('if [[ "$FILE_COUNT" == "0" ]]');
    expect(prepare).toContain('refusing to create an empty verification record');
    expect(prepare.indexOf('if [[ "$FILE_COUNT" == "0" ]]')).toBeLessThan(
      prepare.indexOf('mkdir -p "$TARGET_ABS/files"'),
    );
  });

  it('requires every removal candidate to exist in the verified archive inventory', () => {
    expect(remove).toContain("expanded = archive / 'ops-archive-expanded-files.txt'");
    expect(remove).toContain('missing = sorted(candidates - archived)');
    expect(remove).toContain('removal candidates are absent from archive inventory');
  });

  it('keeps deletion dry-run by default and skips dirty candidate files', () => {
    expect(remove).toContain('CONFIRMED=0');
    expect(remove).toContain('DRY RUN: no files removed');
    expect(remove).toContain('candidate has local changes, skipping');
    expect(remove).toContain("git status --porcelain -- \"$file\"");
  });
});
