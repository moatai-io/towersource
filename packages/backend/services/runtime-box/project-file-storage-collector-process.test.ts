import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { collectStorageSnapshotInProcess as collect } from './project-file-storage-collector-process.js';
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-process-test-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const input = () => ({ projectId: 'p', deploymentId: 'test', rootPath: root });
it('scans through a real subprocess and returns metadata', async () => {
  await fs.writeFile(path.join(root, 'file.txt'), 'data');
  expect(await collect(input())).toMatchObject({ complete: true, entries: [{ path: 'file.txt', sizeBytes: 4 }] });
});
it('kills a timed-out subprocess', async () => {
  await expect(collect(input(), { timeoutMs: 1 })).rejects.toThrow('TIMEOUT');
});
it('does not expose raw filesystem errors', async () => {
  await expect(collect({ ...input(), rootPath: path.join(root, 'missing') })).rejects.toThrow('STORAGE_COLLECTOR_SCAN_FAILED');
});
it('does not inherit NODE_OPTIONS into the child', async () => {
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--invalid-synthetic-test-option';
  try { expect((await collect(input())).complete).toBe(true); }
  finally { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; }
});
