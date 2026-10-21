import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createWorkerReleaseStore } from './workbench-worker-release-store.js';
import type { ReleaseReceipt } from './workbench-worker-release-runner.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-release-store-'));
  roots.push(root); await fs.chmod(root, 0o700);
  return { root, store: await createWorkerReleaseStore(root) };
}
const value: ReleaseReceipt = { runId: 'run1', targetStore: '/nix/store/' + 'a'.repeat(32) + '-new', phase: 'verified', before: { workerId: 'worker', configuredStore: '/nix/store/' + 'b'.repeat(32) + '-old', liveStore: '/nix/store/' + 'b'.repeat(32) + '-old', activeRuns: 0, draining: true } };
it('persists across store instances with private mode and no extra data', async () => {
  const { root, store } = await fixture();
  await store.exclusive('worker', async () => { await store.save({ ...value, secret: 'not-persisted' } as ReleaseReceipt); });
  const reopened = await createWorkerReleaseStore(root);
  await reopened.exclusive('worker', async () => expect(await reopened.load('run1')).toEqual(value));
  const file = path.join(root, 'worker-worker-run-run1.json');
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  expect(await fs.readFile(file, 'utf8')).not.toContain('not-persisted');
});
it('blocks a competing store and a stale lock without stealing it', async () => {
  const { root, store } = await fixture();
  const other = await createWorkerReleaseStore(root);
  await store.exclusive('worker', async () => {
    await expect(other.exclusive('worker', async () => {})).rejects.toMatchObject({ code: 'EEXIST' });
  });
  await fs.mkdir(path.join(root, 'worker-worker.lock'));
  await expect(store.exclusive('worker', async () => {})).rejects.toMatchObject({ code: 'EEXIST' });
});
it('rejects missing lock, path traversal, and changed rollback baseline', async () => {
  const { store } = await fixture();
  await expect(store.save(value)).rejects.toThrow('LOCK_REQUIRED');
  await expect(store.exclusive('../worker', async () => {})).rejects.toThrow();
  await store.exclusive('worker', async () => {
    await store.save(value);
    await expect(store.save({ ...value, before: { ...value.before, draining: false } })).rejects.toThrow('RECEIPT_CONFLICT');
  });
});
it('refuses symlink receipts instead of reading outside the private root', async () => {
  const { root, store } = await fixture();
  await fs.symlink('/nonexistent-fixture', path.join(root, 'worker-worker-run-run1.json'));
  await expect(store.exclusive('worker', async () => { await store.load('run1'); })).rejects.toMatchObject({ code: 'ELOOP' });
});
it('rejects a group-writable journal root', async () => {
  const { root } = await fixture(); await fs.chmod(root, 0o770);
  await expect(createWorkerReleaseStore(root)).rejects.toThrow('PRIVATE_ROOT_REQUIRED');
});
it('retains the Worker lock across recovery-required and new run attempts', async () => {
  const { root, store } = await fixture();
  await store.exclusive('worker', async () => { await store.save({ ...value, phase: 'recovery-required' }); });
  const next = await createWorkerReleaseStore(root);
  await expect(next.exclusive('worker', async () => {})).rejects.toMatchObject({ code: 'EEXIST' });
});
it('retains the lock when a callback fails before confirming a terminal state', async () => {
  const { root, store } = await fixture();
  await expect(store.exclusive('worker', async () => { throw new Error('disk unavailable'); })).rejects.toThrow();
  expect((await fs.stat(path.join(root, 'worker-worker.lock'))).isDirectory()).toBe(true);
});
