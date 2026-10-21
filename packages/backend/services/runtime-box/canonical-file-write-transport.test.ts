const keys = generateKeyPairSync('ed25519');
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { sendCanonicalTextWrite } from './canonical-file-write-transport.js';
import { verifyCanonicalFileWriteGrant } from './canonical-file-write-grant.js';
import { createHash } from 'node:crypto';
const request = { baseUrl: 'http://127.0.0.1:9999', secret: 'synthetic-write-transport', signingKey: keys.privateKey, workerId: 'w', projectId: 'p', projectRoot: '/work/p', actorUserId: 7, relativePath: 'a b.txt', mode: 'replace' as const, content: '한글' };
afterEach(() => vi.unstubAllGlobals());
it('sends one exact UTF-8 payload and scope-bound grant, with no readiness request', async () => {
 const fetcher = vi.fn(async () => new Response(JSON.stringify({ bytesWritten: 6 }), { status: 200 }));
 vi.stubGlobal('fetch', fetcher);
 expect(await sendCanonicalTextWrite(request)).toEqual({ bytesWritten: 6 });
 expect(fetcher).toHaveBeenCalledTimes(1);
 const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
 expect(String(url)).toBe('http://127.0.0.1:9999/v1/canonical-files/p/content?path=a+b.txt');
 const headers = new Headers(init.headers);
 const scope = JSON.parse(Buffer.from(headers.get('x-tower-write-scope')!, 'base64url').toString());
 expect(verifyCanonicalFileWriteGrant({ verificationKey: keys.publicKey, token: headers.get('x-tower-write-grant')!, expected: scope }).scope.bodySha256).toBe(createHash('sha256').update(request.content).digest('hex'));
 expect(headers.get('content-length')).toBe('6');
 expect(Buffer.from(init.body as Uint8Array).toString()).toBe(request.content);
});
it.each([403,404,409,503])('does not retry HTTP %s or expose response diagnostics', async status => {
 const fetcher = vi.fn(async () => new Response('private-response-details', { status })); vi.stubGlobal('fetch', fetcher);
 await expect(sendCanonicalTextWrite(request)).rejects.toThrow(status === 403 ? 'DENIED' : status === 404 || status === 503 ? 'UNAVAILABLE' : 'NOT_CONFIRMED');
 expect(fetcher).toHaveBeenCalledTimes(1);
});
it('treats a dropped response as unknown outcome without retry', async () => {
 const fetcher = vi.fn(async () => { throw new Error('private-network-details'); }); vi.stubGlobal('fetch', fetcher);
 await expect(sendCanonicalTextWrite(request)).rejects.toThrow('CANONICAL_WRITE_NOT_CONFIRMED'); expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each(['bad-json', '{"bytesWritten":1}', '{"bytesWritten":6,"secret":"extra"}'])('does not claim success from malformed receipt %s', async body => {
 const fetcher = vi.fn(async () => new Response(body, { status: 200 })); vi.stubGlobal('fetch', fetcher);
 await expect(sendCanonicalTextWrite(request)).rejects.toThrow('NOT_CONFIRMED'); expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([{ relativePath: '../outside' }, { baseUrl: 'file:///tmp/file' }, { baseUrl: 'http://user:pass@host' }, { content: '\ud800' }, { timeoutMs: 0 }])('rejects invalid trusted configuration or content before I/O %j', async changes => {
 const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
 await expect(sendCanonicalTextWrite({ ...request, ...changes })).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
});
