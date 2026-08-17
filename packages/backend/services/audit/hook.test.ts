import { describe, expect, it } from 'vitest';
import { extractBashTargets, isSuspiciousPathToken, normalizeTrackedPath } from './hook.js';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const HOME = homedir();

describe('audit provenance hook helpers', () => {
  it('normalizes tower repo paths with schema v2 fields', () => {
    const abs = resolve(HOME, 'tower/packages/shared/index.ts');
    expect(normalizeTrackedPath(abs, resolve(HOME, 'tower'))).toEqual({
      path: abs,
      cwd: resolve(HOME, 'tower'),
      scope: 'tower-repo',
      repo: resolve(HOME, 'tower'),
      relpath: 'packages/shared/index.ts',
    });
  });

  it('normalizes workspace paths separately from tower repo', () => {
    const abs = resolve(HOME, 'workspace/projects/foo/report.md');
    expect(normalizeTrackedPath(abs, resolve(HOME, 'workspace/projects/foo'))).toMatchObject({
      path: abs,
      scope: 'workspace',
      repo: resolve(HOME, 'workspace'),
      relpath: 'projects/foo/report.md',
    });
  });

  it('rejects shell syntax that would become fake repo paths', () => {
    for (const token of ['$TMPFILE', '2>/dev/null', 'https://github.com/a/b.git', '*.ts', 'foo && bar']) {
      expect(isSuspiciousPathToken(token), token).toBe(true);
    }
    expect(isSuspiciousPathToken('packages/backend/index.ts')).toBe(false);
  });

  it('extracts only high-confidence bash mutation targets', () => {
    expect(extractBashTargets('mkdir -p packages/foo && touch packages/foo/a.ts 2>/dev/null')).toEqual([
      { action: 'mkdir', target: 'packages/foo' },
      { action: 'touch', target: 'packages/foo/a.ts' },
    ]);
    expect(extractBashTargets('cp src/a.ts packages/a.ts')).toEqual([
      { action: 'cp', target: 'packages/a.ts', src: 'src/a.ts' },
    ]);
    expect(extractBashTargets('git clone https://github.com/acme/repo.git .tmp/repo')).toEqual([
      { action: 'git-clone', target: '.tmp/repo', src: 'https://github.com/acme/repo.git' },
    ]);
  });
});
