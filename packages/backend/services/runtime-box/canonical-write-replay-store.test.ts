import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createCanonicalWriteReplayStore } from './canonical-write-replay-store.js';
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'write-replay-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it('admits exactly one concurrent consumer and persists across handler recreation', async () => {
 const nonce = randomUUID(); const expires = Date.now() + 60_000;
 const first = await createCanonicalWriteReplayStore(root);
 const second = await createCanonicalWriteReplayStore(root);
 expect((await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second)(nonce, expires)))).filter(Boolean)).toHaveLength(1);
 const restarted = await createCanonicalWriteReplayStore(root);
 expect(await restarted(nonce, expires)).toBe(false);
});
it('stores no payload or credential and restricts receipt permissions', async () => {
 const consume = await createCanonicalWriteReplayStore(root); const nonce = randomUUID();
 await consume(nonce, Date.now() + 10_000);
 const receipt = path.join(root, nonce);
 expect((await fs.stat(receipt)).mode & 0o777).toBe(0o600);
 expect(await fs.readFile(receipt, 'utf8')).toBe('');
});
it('rejects invalid or expired claims before creating a record', async () => {
 const consume = await createCanonicalWriteReplayStore(root);
 for (const [nonce, expiry] of [['../escape', Date.now()+1000], [randomUUID(), Date.now()-1], [randomUUID(), NaN], [randomUUID(), Date.now()+120_000]] as const) {
  await expect(consume(nonce, expiry)).rejects.toThrow();
 }
 expect(await fs.readdir(root)).toEqual([]);
});
it('rejects a symlink or insecure runtime root', async () => {
 const alias = `${root}/alias`; await fs.symlink(root, alias);
 expect(() => createCanonicalWriteReplayStore(alias)).toThrow();
 await fs.chmod(root, 0o755);
 expect(() => createCanonicalWriteReplayStore(root)).toThrow();
});
it('rejects a symlink ancestor', async () => {
 await fs.mkdir(path.join(root, 'real')); await fs.mkdir(path.join(root, 'real/store'), { mode: 0o700 });
 await fs.symlink(path.join(root, 'real'), path.join(root, 'alias'));
 expect(() => createCanonicalWriteReplayStore(path.join(root, 'alias/store'))).toThrow();
});
it('does not admit a replay after the record was truncated or turned into a symlink', async () => {
 const consume = await createCanonicalWriteReplayStore(root); const nonce = randomUUID();
 await fs.symlink('/nonexistent', path.join(root, nonce));
 expect(await consume(nonce, Date.now()+1000)).toBe(false);
});
it('refuses a replaced runtime root instead of switching stores', async () => {
 const consume = await createCanonicalWriteReplayStore(root);
 await fs.rename(root, root + '.old');
 try { await fs.mkdir(root, { mode: 0o700 }); await expect(consume(randomUUID(), Date.now()+1000)).rejects.toThrow(); }
 finally { await fs.rm(root + '.old', { recursive:true, force:true }); }
});
