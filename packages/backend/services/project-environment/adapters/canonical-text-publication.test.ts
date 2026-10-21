import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeCanonicalProjectText } from './canonical-host-file-adapter.js';
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'text-publication-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive:true, force:true }); });
it('preserves existing bytes and mode when writing the staged content fails', () => {
 const target = path.join(root, 'a.txt'); fs.writeFileSync(target, 'original', { mode: 0o600 });
 vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('simulated disk error'); });
 expect(() => writeCanonicalProjectText(root, 'a.txt', 'new')).toThrow('simulated disk error');
 expect(fs.readFileSync(target, 'utf8')).toBe('original');
 expect(fs.statSync(target).mode & 0o777).toBe(0o600);
 expect(fs.readdirSync(root)).toEqual(['a.txt']);
});
it.each([false,true])('does not expose a partial new file after staging failure (exclusive=%s)', exclusive => {
 vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('simulated disk error'); });
 expect(() => writeCanonicalProjectText(root, 'a.txt', 'new', exclusive)).toThrow();
 expect(fs.readdirSync(root)).toEqual([]);
});
it('publishes new contents and preserves exclusive create semantics', () => {
 writeCanonicalProjectText(root, 'nested/a.txt', 'first', true);
 expect(() => writeCanonicalProjectText(root, 'nested/a.txt', 'second', true)).toThrow();
 expect(fs.readFileSync(path.join(root, 'nested/a.txt'), 'utf8')).toBe('first');
 writeCanonicalProjectText(root, 'nested/a.txt', 'replacement');
 expect(fs.readFileSync(path.join(root, 'nested/a.txt'), 'utf8')).toBe('replacement');
 expect(fs.readdirSync(path.join(root,'nested')).some(name => name.startsWith('.tower-write-'))).toBe(false);
});
it('rejects a hardlinked existing file without changing either name', () => {
 fs.writeFileSync(path.join(root,'original'), 'old'); fs.linkSync(path.join(root,'original'), path.join(root,'alias'));
 expect(() => writeCanonicalProjectText(root, 'alias', 'new')).toThrow();
 expect(fs.readFileSync(path.join(root,'original'),'utf8')).toBe('old');
});
