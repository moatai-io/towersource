import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { snapshotGitFiles, changedGitFiles, wrapBashChangeObserver } from './bash-change-observer.js';
const dirs: string[] = [];
afterEach(async () => { for (const p of dirs.splice(0)) await fs.rm(p, { recursive: true, force: true }); });
async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bash-observer-')); dirs.push(root);
  execFileSync('git', ['init', '-q', root]); return root;
}
describe('bash temporal evidence', () => {
  it('detects edits to already dirty files, additions, and deletions without reading secrets', async () => {
    const root = await repo();
    await fs.writeFile(path.join(root, 'a.ts'), 'before');
    await fs.writeFile(path.join(root, 'gone.ts'), 'delete');
    await fs.writeFile(path.join(root, '.env'), 'sensitive');
    const before = await snapshotGitFiles(root);
    await fs.writeFile(path.join(root, 'a.ts'), 'after');
    await fs.writeFile(path.join(root, 'new.ts'), 'new');
    await fs.unlink(path.join(root, 'gone.ts'));
    expect(changedGitFiles(before, await snapshotGitFiles(root)).sort()).toEqual(['a.ts', 'gone.ts', 'new.ts']);
    expect(before.has('.env')).toBe(false);
  });
  it('records partial writes on command failure without recording command or content', async () => {
    const root = await repo();
    const tool = wrapBashChangeObserver({ execute: async () => { await fs.writeFile(path.join(root, 'a.ts'), 'private body'); throw new Error('command failure'); } }, { cwd: root, sessionId: 'session-a' });
    await expect(tool.execute('call-a', { command: 'private command' })).rejects.toThrow('command failure');
    const text = await fs.readFile(path.join(root, '.git/tower-bash-observations.jsonl'), 'utf8');
    expect(text).not.toContain('private');
    expect(JSON.parse(text)).toMatchObject({ sessionId: 'session-a', evidence: 'temporal-candidate', complete: true, paths: ['a.ts'] });
  });
});
