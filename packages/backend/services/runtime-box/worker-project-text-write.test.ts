import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { receiveWorkerProjectTextWrite } from './worker-project-text-write.js';

const roots: string[] = [];
const stagingPaths: string[] = [];
const originalMkdtemp = fs.mkdtemp.bind(fs);
vi.spyOn(fs, 'mkdtemp').mockImplementation(async (...args: Parameters<typeof fs.mkdtemp>) => {
  const result = await originalMkdtemp(...args);
  if (String(args[0]).includes('tower-worker-text-')) stagingPaths.push(String(result));
  return result;
});
afterEach(async () => {
  for (const temporary of stagingPaths.splice(0)) await expect(fs.stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-text-test-')); roots.push(root); return root; }
async function* chunks(text: string) { yield Buffer.from(text); }
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('Worker raw text publication', () => {
  it('writes a large unicode body exclusively without overwriting a collision', async () => {
    const projectRoot = await fixture(); const content = '\uFEFF# 자료\n' + '긴 문서 내용\n'.repeat(20000);
    const input = { projectRoot, relativePath: 'work/large.md', mode: 'exclusive' as const, expectedBytes: Buffer.byteLength(content), chunks: chunks(content) };
    await receiveWorkerProjectTextWrite(input);
    expect(await fs.readFile(path.join(projectRoot, 'work/large.md'), 'utf8')).toBe(content);
    await expect(receiveWorkerProjectTextWrite({ ...input, chunks: chunks('replacement'), expectedBytes: 11 })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(path.join(projectRoot, 'work/large.md'), 'utf8')).toBe(content);
  });

  it('CAS preserves file-only ACLs and rejects a stale snapshot', async () => {
    const projectRoot = await fixture(); const target = path.join(projectRoot, 'shared.md');
    const original = 'first\n'.repeat(20000); await fs.writeFile(target, original, { mode: 0o600 });
    execFileSync('setfacl', ['-m', `u:${process.getuid!() + 10000}:r--`, target]);
    const before = execFileSync('getfacl', ['-cpn', target], { encoding: 'utf8' });
    const replacement = 'second\n'.repeat(20000);
    const input = { projectRoot, relativePath: 'shared.md', mode: 'cas' as const, expectedSha256: hash(original), expectedBytes: Buffer.byteLength(replacement), chunks: chunks(replacement) };
    await receiveWorkerProjectTextWrite(input);
    expect(await fs.readFile(target, 'utf8')).toBe(replacement);
    expect(execFileSync('getfacl', ['-cpn', target], { encoding: 'utf8' })).toBe(before);
    await expect(receiveWorkerProjectTextWrite({ ...input, chunks: chunks(replacement) })).rejects.toThrow('SCOPED_EDIT_STALE_SOURCE');
    expect(await fs.readFile(target, 'utf8')).toBe(replacement);
  });

  it('rejects changes while the request body is arriving and preserves external edits', async () => {
    const projectRoot = await fixture(); const target = path.join(projectRoot, 'race.md'); await fs.writeFile(target, 'first');
    async function* body() { yield Buffer.from('next'); await fs.writeFile(target, 'external'); }
    await expect(receiveWorkerProjectTextWrite({ projectRoot, relativePath: 'race.md', mode: 'cas', expectedSha256: hash('first'), expectedBytes: 4, chunks: body() })).rejects.toThrow('SCOPED_EDIT_STALE_SOURCE');
    expect(await fs.readFile(target, 'utf8')).toBe('external');
  });

  it('does not publish partial, invalid UTF-8, disconnected or oversized requests', async () => {
    const projectRoot = await fixture(); const target = path.join(projectRoot, 'target.md'); await fs.writeFile(target, 'original');
    const input = { projectRoot, relativePath: 'target.md', mode: 'replace' as const, expectedBytes: 10 };
    await expect(receiveWorkerProjectTextWrite({ ...input, chunks: chunks('short') })).rejects.toThrow('LENGTH_MISMATCH');
    async function* invalid() { yield Buffer.from([0xff]); }
    await expect(receiveWorkerProjectTextWrite({ ...input, expectedBytes: 1, chunks: invalid() })).rejects.toThrow();
    async function* disconnected() { yield Buffer.from('part'); throw new Error('disconnected'); }
    await expect(receiveWorkerProjectTextWrite({ ...input, chunks: disconnected() })).rejects.toThrow('disconnected');
    await expect(receiveWorkerProjectTextWrite({ ...input, expectedBytes: 101 * 1024 * 1024, chunks: chunks('') })).rejects.toThrow('SIZE_LIMIT');
    expect(await fs.readFile(target, 'utf8')).toBe('original');
    expect(await fs.readdir(projectRoot)).toEqual(['target.md']);
  });

  it('rejects traversal, symlinks and hardlinks without editing their contents', async () => {
    const projectRoot = await fixture(); const target = path.join(projectRoot, 'original'); await fs.writeFile(target, 'original');
    await fs.symlink(target, path.join(projectRoot, 'link')); await fs.link(target, path.join(projectRoot, 'hard'));
    for (const relativePath of ['../escape', 'link', 'hard']) {
      await expect(receiveWorkerProjectTextWrite({ projectRoot, relativePath, mode: 'replace', expectedBytes: 4, chunks: chunks('next') })).rejects.toThrow();
    }
    expect(await fs.readFile(target, 'utf8')).toBe('original');
  });
});

it('checks the expected body digest before publication and preserves existing bytes on tampering', async () => {
 const projectRoot = await fixture();
 await fs.writeFile(path.join(projectRoot, 'a.txt'), 'original');
 const input = { projectRoot, relativePath: 'a.txt', mode: 'replace' as const, expectedBytes: 4, expectedBodySha256: hash('good') };
 await expect(receiveWorkerProjectTextWrite({ ...input, chunks: chunks('evil') })).rejects.toThrow('BODY_MISMATCH');
 expect(await fs.readFile(path.join(projectRoot, 'a.txt'), 'utf8')).toBe('original');
 await receiveWorkerProjectTextWrite({ ...input, chunks: chunks('good') });
 expect(await fs.readFile(path.join(projectRoot, 'a.txt'), 'utf8')).toBe('good');
});

it('rejects replacement of the root during body transfer rather than writing the new directory', async () => {
 const projectRoot = await fixture(); const moved = `${projectRoot}-moved`;
 await fs.writeFile(path.join(projectRoot, 'a.txt'), 'original');
 async function* replaceRoot() {
  yield Buffer.from('ne');
  await fs.rename(projectRoot, moved);
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(projectRoot, 'a.txt'), 'unrelated');
  yield Buffer.from('xt');
 }
 try {
  await expect(receiveWorkerProjectTextWrite({ projectRoot, relativePath: 'a.txt', mode: 'replace', expectedBytes: 4, chunks: replaceRoot() })).rejects.toThrow('ROOT_CHANGED');
  expect(await fs.readFile(path.join(projectRoot, 'a.txt'), 'utf8')).toBe('unrelated');
  expect(await fs.readFile(path.join(moved, 'a.txt'), 'utf8')).toBe('original');
 } finally { await fs.rm(moved, { recursive: true, force: true }); }
});
it('rejects root replacement performed while the authority callback is pending', async () => {
 const projectRoot = await fixture(); const moved = `${projectRoot}-moved`;
 await fs.writeFile(path.join(projectRoot, 'a.txt'), 'original');
 try {
  await expect(receiveWorkerProjectTextWrite({ projectRoot, relativePath: 'a.txt', mode: 'replace', expectedBytes: 4, chunks: chunks('next'),
   beforePublish: async () => { await fs.rename(projectRoot, moved); await fs.mkdir(projectRoot); },
  })).rejects.toThrow('ROOT_CHANGED');
  await expect(fs.stat(path.join(projectRoot, 'a.txt'))).rejects.toThrow();
 } finally { await fs.rm(moved, { recursive: true, force: true }); }
});
