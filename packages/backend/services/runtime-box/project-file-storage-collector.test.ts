import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { collectHostStorageSnapshot as collect } from './project-file-storage-collector.js';
import { planProjectFileStoragePreflight } from './project-file-storage-preflight.js';
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-collector-test-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const input = () => ({ rootPath: root, projectId: 'p', deploymentId: 'test' });
it('hashes real files including hidden files and feeds the planner without exposing bytes', () => {
  fs.mkdirSync(path.join(root, 'final'));
  fs.writeFileSync(path.join(root, 'final', '한글.html'), 'hello');
  fs.writeFileSync(path.join(root, '.hidden'), 'hidden');
  const host = collect(input());
  expect(host.entries).toHaveLength(3);
  expect(host.entries.find(e => e.path === 'final/한글.html')).toMatchObject({ sizeBytes: 5, sha256: createHash('sha256').update('hello').digest('hex') });
  expect(JSON.stringify(host)).not.toContain('hello');
  const result = planProjectFileStoragePreflight({ projectId: 'p', deploymentId: 'test', target: host.source, host, worker: { ...host, source: { kind: 'worker', workerId: 'w' } }, now: Date.now() });
  expect(result.status).toBe('content-matched');
  expect(result.readyToActivate).toBe(false);
});
it('rejects symlinks rather than silently omitting them', () => {
  fs.symlinkSync('/etc', path.join(root, 'outside'));
  expect(() => collect(input())).toThrow('SPECIAL_ENTRY');
});
it('rejects hardlinked files', () => {
  fs.writeFileSync(path.join(root, 'a'), 'data');
  fs.linkSync(path.join(root, 'a'), path.join(root, 'b'));
  expect(() => collect(input())).toThrow('SPECIAL_ENTRY');
});
it('rejects symlinked root ancestors', () => {
  fs.mkdirSync(path.join(root, 'real')); fs.mkdirSync(path.join(root, 'real', 'child'));
  fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'));
  expect(() => collect({ ...input(), rootPath: path.join(root, 'alias', 'child') })).toThrow();
});
it('fails rather than returning a truncated complete snapshot', () => {
  fs.writeFileSync(path.join(root, 'a'), '1234');
  expect(() => collect({ ...input(), maxBytes: 3 })).toThrow('BYTE_LIMIT');
  fs.writeFileSync(path.join(root, 'b'), 'x');
  expect(() => collect({ ...input(), maxEntries: 1 })).toThrow('ENTRY_LIMIT');
});
it('bounds recursive directory depth', () => {
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  expect(() => collect({ ...input(), maxDepth: 1 })).toThrow('DEPTH_LIMIT');
});
it('rejects invalid roots and limits', () => {
  expect(() => collect({ ...input(), rootPath: 'relative' })).toThrow('INPUT_INVALID');
  expect(() => collect({ ...input(), maxBytes: Infinity })).toThrow('LIMIT_INVALID');
});
