import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('pre-push dependency retention', () => {
  it('keeps two newest plus linked snapshots and only applies on request', () => {
    const root = mkdtempSync(join(tmpdir(), 'prepush-prune-'));
    try {
      const cache = join(root, 'cache');
      const snapshots = join(root, 'snapshots');
      mkdirSync(cache); mkdirSync(snapshots);
      const names = ['a', 'b', 'c', 'd'].map(c => c.repeat(64));
      for (const [i, name] of names.entries()) {
        const dir = join(cache, name); mkdirSync(join(dir, 'node_modules'), { recursive: true });
        writeFileSync(join(dir, '.tower-prepush-dependencies-ready'), '');
        const time = new Date(1_600_000_000_000 + i * 1000);
        utimesSync(dir, time, time);
      }
      const source = join(snapshots, 'active', 'source');
      mkdirSync(source, { recursive: true });
      symlinkSync(join(cache, names[0], 'node_modules'), join(source, 'node_modules'));
      const script = resolve('scripts/git/prune-prepush-dependencies');
      const args = ['--cache', cache, '--snapshots', snapshots];
      const dry = execFileSync('python3', [script, ...args], { encoding: 'utf8' });
      expect(dry).toContain(`would remove ${names[1]}`);
      expect(readdirSync(cache).filter(n => n.length === 64)).toHaveLength(4);
      execFileSync('python3', [script, ...args, '--apply']);
      expect(readdirSync(cache).filter(n => n.length === 64).sort()).toEqual([names[0], names[2], names[3]]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
