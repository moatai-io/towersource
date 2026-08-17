import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  scanSkillBundleForMaterialization,
  scanSkillBundleForReadOnlyMount,
} from './skill-materialization-scanner.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-skill-materialization-scanner-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root: string, relativePath: string, content = 'x'): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('skill-materialization-scanner', () => {
  it('allows a small normal skill bundle', () => {
    const root = makeTempDir();
    writeFile(root, 'SKILL.md', '# skill');
    writeFile(root, 'scripts/run.sh', 'echo ok');
    writeFile(root, 'references/guide.md', 'guide');

    const result = scanSkillBundleForMaterialization(root);

    expect(result.ok).toBe(true);
    expect(result.filesAllowed).toEqual(['SKILL.md', 'references/guide.md', 'scripts/run.sh']);
    expect(result.findings).toEqual([]);
  });

  it('blocks secret-like files while skipping generated dependency/cache folders', () => {
    const root = makeTempDir();
    writeFile(root, 'SKILL.md', '# skill');
    writeFile(root, 'scripts/run.py', 'print("ok")');
    writeFile(root, '.env', 'TOKEN=value');
    writeFile(root, 'scripts/private-key.pem', 'key');
    writeFile(root, 'node_modules/pkg/index.js', 'module');
    writeFile(root, 'scripts/__pycache__/run.cpython-310.pyc', 'compiled');
    writeFile(root, 'references/api_token.txt', 'token');

    const result = scanSkillBundleForMaterialization(root);

    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toEqual(expect.arrayContaining([
      'denied_name',
      'denied_extension',
      'secret_like_name',
      'generated_artifact_skipped',
    ]));
    expect(result.filesAllowed).toEqual(['SKILL.md', 'scripts/run.py']);
  });

  it('allows materialization when the only unsafe-looking entries are generated artifacts', () => {
    const root = makeTempDir();
    writeFile(root, 'SKILL.md', '# skill');
    writeFile(root, 'scripts/run.py', 'print("ok")');
    writeFile(root, 'scripts/__pycache__/run.cpython-310.pyc', 'compiled');
    writeFile(root, '.pytest_cache/README.md', 'cache');

    const result = scanSkillBundleForMaterialization(root);

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'generated_artifact_skipped', relativePath: 'scripts/__pycache__' }),
      expect.objectContaining({ code: 'generated_artifact_skipped', relativePath: '.pytest_cache' }),
    ]));
    expect(result.filesAllowed).toEqual(['SKILL.md', 'scripts/run.py']);
  });

  it('allows explicitly allowlisted secret-like documentation file names', () => {
    const root = makeTempDir();
    writeFile(root, 'SKILL.md', '# skill');
    writeFile(root, 'references/api_token.md', 'This describes token setup but has no value.');

    const result = scanSkillBundleForMaterialization(root, {
      allowSecretLikeFiles: ['references/api_token.md'],
    });

    expect(result.ok).toBe(true);
    expect(result.filesAllowed).toEqual(['SKILL.md', 'references/api_token.md']);
  });

  it('allows large files and bundles for read-only mounts but copy scanning still caps them', () => {
    const root = makeTempDir();
    writeFile(root, 'SKILL.md', '# skill');
    writeFile(root, 'references/large.bin', 'x'.repeat(3 * 1024 * 1024));

    expect(scanSkillBundleForMaterialization(root)).toMatchObject({
      ok: false,
      findings: [expect.objectContaining({ code: 'file_too_large' })],
    });
    expect(scanSkillBundleForReadOnlyMount(root)).toMatchObject({
      ok: true,
      findings: [],
      filesAllowed: ['SKILL.md', 'references/large.bin'],
    });
  });

  it('warns about generated/cache paths in full-directory read-only mounts', () => {
    const root = makeTempDir();
    writeFile(root, 'SKILL.md', '# skill');
    writeFile(root, 'scripts/__pycache__/run.pyc', 'compiled');

    expect(scanSkillBundleForReadOnlyMount(root)).toMatchObject({
      ok: true,
      findings: [expect.objectContaining({
        severity: 'warning',
        code: 'generated_artifact_skipped',
        relativePath: 'scripts/__pycache__',
      })],
    });
  });

  it('blocks symlinks that escape the skill root', () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    writeFile(root, 'SKILL.md', '# skill');
    writeFile(outside, 'outside.txt', 'outside');
    fs.symlinkSync(path.join(outside, 'outside.txt'), path.join(root, 'outside-link'));

    const result = scanSkillBundleForMaterialization(root);

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'symlink_escape',
      relativePath: 'outside-link',
    }));
  });
});
