const keys = generateKeyPairSync('ed25519');
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRemoteWorkbenchWorkerServer } from '../execution/worker/worker-server.js';
import { createCanonicalWriteReplayStore } from './canonical-write-replay-store.js';
import { sendCanonicalTextWrite } from './canonical-file-write-transport.js';
import { issueCanonicalFileWriteGrant } from './canonical-file-write-grant.js';
const secret = 'synthetic-write-http-secret';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
let root: string; let server: http.Server; let url: string;
let authorize: ReturnType<typeof vi.fn>; let consume: ReturnType<typeof vi.fn>;
const used = new Set<string>();
beforeEach(async () => {
 root = await fs.mkdtemp(path.join(os.tmpdir(), 'canonical-write-http-'));
 await fs.writeFile(path.join(root, 'a.txt'), 'old');
 used.clear(); authorize = vi.fn(async () => {});
 // Test-only durable-store substitute. Production must supply atomic persistent consume.
 consume = vi.fn(async (nonce: string) => { if (used.has(nonce)) return false; used.add(nonce); return true; });
});
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } await fs.rm(root, { recursive: true, force: true }); });
async function start(enabled = true) {
 server = createRemoteWorkbenchWorkerServer({ workerId: 'w', token: secret, projects: {},
 ...(enabled ? { canonicalFileWrites: { verificationKey: keys.publicKey, authorize, consume } } : {}),
 });
 await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
 url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
}
function scope() { return { workerId: 'w', projectId: 'p', projectRoot: root, actorUserId: 7, relativePath: 'a.txt', mode: 'replace' as const, bodySha256: hash('new'), bytes: 3 }; }
async function put(options: { token?: string; body?: string; scope?: ReturnType<typeof scope>; auth?: string } = {}) {
 const expected = options.scope ?? scope();
 const response = await fetch(`${url}/v1/canonical-files/p/content?path=a.txt`, { method: 'PUT',
 headers: { authorization: `Bearer ${options.auth ?? secret}`, 'x-tower-write-scope': Buffer.from(JSON.stringify(expected)).toString('base64url'),
 'x-tower-write-grant': options.token ?? issueCanonicalFileWriteGrant({ signingKey: keys.privateKey, scope: expected }), 'content-length': '3' }, body: options.body ?? 'new' });
 return { status: response.status, text: await response.text() };
}
it('is unavailable by default without falling back to static Project files', async () => { await start(false); expect((await put()).status).toBe(404); expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('old'); });
it('writes approved canonical bytes without static Project membership', async () => { await start(); expect((await put()).status).toBe(200); expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('new'); expect(authorize).toHaveBeenCalledTimes(2); expect(consume).toHaveBeenCalledTimes(1); });
it('rejects replay with unchanged bytes', async () => { await start(); const token = issueCanonicalFileWriteGrant({ signingKey: keys.privateKey, scope: scope() }); expect((await put({ token })).status).toBe(200); await fs.writeFile(path.join(root, 'a.txt'), 'later'); expect((await put({ token })).status).toBe(403); expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('later'); });
it('preserves original bytes when current permission is revoked before publication', async () => { await start(); authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('private-db-diagnostic')); const response = await put(); expect(response.status).toBe(403); expect(response.text).not.toContain('private-db'); expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('old'); });
it('rejects tampered body before publication', async () => { await start(); expect((await put({ body: 'bad' })).status).toBe(409); expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('old'); });
it('rejects unsigned, altered scope and wrong Worker before authority callbacks', async () => { await start(); const token = issueCanonicalFileWriteGrant({ signingKey: keys.privateKey, scope: scope() }); expect((await put({ token, scope: { ...scope(), actorUserId: 8 } })).status).toBe(403); expect((await put({ scope: { ...scope(), workerId: 'other' } })).status).toBe(403); expect((await put({ token: 'invalid' })).status).toBe(403); expect(authorize).not.toHaveBeenCalled(); });
it('checks expiry again before publication', async () => { await start(); const now = Date.now(); const token = issueCanonicalFileWriteGrant({ signingKey: keys.privateKey, scope: scope(), nowMs: now, ttlMs: 500 }); authorize.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { vi.spyOn(Date, 'now').mockReturnValue(now + 501); }); try { expect((await put({ token })).status).toBe(403); expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('old'); } finally { vi.restoreAllMocks(); } });
it('retains Worker authentication', async () => { await start(); expect((await put({ auth: 'wrong' })).status).toBe(401); expect(authorize).not.toHaveBeenCalled(); });

it('uses the actual sender and receiver for canonical UTF-8 write with no static allowlist', async () => {
 await start();
 expect(await sendCanonicalTextWrite({ baseUrl: url, secret, signingKey: keys.privateKey, ...scope(), content: '공유 파일' })).toEqual({ bytesWritten: Buffer.byteLength('공유 파일') });
 expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('공유 파일');
 expect(authorize).toHaveBeenCalledTimes(2);
});

it('rejects the same grant after HTTP server and replay handler recreation', async () => {
 // Synthetic runtime dir only; production must place this outside Project roots.
 const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'write-http-replay-'));
 try {
  consume = vi.fn(await createCanonicalWriteReplayStore(runtime)); await start();
  const token = issueCanonicalFileWriteGrant({ signingKey: keys.privateKey, scope: scope() });
  expect((await put({ token })).status).toBe(200);
  server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  consume = vi.fn(await createCanonicalWriteReplayStore(runtime)); await start();
  await fs.writeFile(path.join(root, 'a.txt'), 'later');
  expect((await put({ token })).status).toBe(403);
  expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('later');
 } finally { await fs.rm(runtime, { recursive: true, force: true }); }
});

it('rejects a token signed by a Worker-controlled key before authorization or consumption', async () => {
 await start();
 const forgedScope = { ...scope(), actorUserId: 999 };
 const forged = issueCanonicalFileWriteGrant({ signingKey: generateKeyPairSync('ed25519').privateKey, scope: forgedScope });
 expect((await put({ token: forged, scope: forgedScope })).status).toBe(403);
 expect(authorize).not.toHaveBeenCalled(); expect(consume).not.toHaveBeenCalled();
 expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('old');
});

it('forwards the original signed grant for both Backend authority checks', async () => {
 await start(); const token = issueCanonicalFileWriteGrant({ signingKey: keys.privateKey, scope: scope() });
 expect((await put({ token })).status).toBe(200);
 expect(authorize.mock.calls).toEqual([[scope(), token], [scope(), token]]);
});
