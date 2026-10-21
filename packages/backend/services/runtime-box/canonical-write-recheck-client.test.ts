import { afterEach, expect, it, vi } from 'vitest';
import { createCanonicalWriteRecheckClient } from './canonical-write-recheck-client.js';
const scope = { workerId: 'w', projectId: 'p', projectRoot: '/work/p', actorUserId: 7, relativePath: 'a.txt', mode: 'replace' as const, bytes: 3, bodySha256: 'a'.repeat(64) };
const options = { backendUrl: 'https://controller.example.com', workerIdentityToken: 'synthetic-worker-jwt', timeoutMs: 1000 };
afterEach(() => vi.unstubAllGlobals());
it('sends exact received grant and scope with Worker identity, accepting only 204', async () => {
 const fetcher = vi.fn(async () => new Response(null, { status: 204 })); vi.stubGlobal('fetch', fetcher);
 await createCanonicalWriteRecheckClient(options)(scope, 'signed-grant');
 expect(fetcher).toHaveBeenCalledTimes(1);
 const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
 expect(String(url)).toBe('https://controller.example.com/api/workbench-workers/canonical-write/recheck');
 expect(init.redirect).toBe('error'); expect(init.method).toBe('POST');
 expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-worker-jwt');
 expect(JSON.parse(init.body as string)).toEqual({ token: 'signed-grant', scope });
});
it.each([200,401,403,404,500])('denies response %s without retry or diagnostic leakage', async status => {
 const fetcher = vi.fn(async () => new Response('private-diagnostics', { status })); vi.stubGlobal('fetch', fetcher);
 await expect(createCanonicalWriteRecheckClient(options)(scope, 'signed-grant')).rejects.toThrow('CANONICAL_WRITE_RECHECK_DENIED');
 expect(fetcher).toHaveBeenCalledTimes(1);
});
it('denies transport failure without retry', async () => {
 const fetcher = vi.fn(async () => { throw new Error('private-network'); }); vi.stubGlobal('fetch', fetcher);
 await expect(createCanonicalWriteRecheckClient(options)(scope, 'signed-grant')).rejects.toThrow('CANONICAL_WRITE_RECHECK_UNAVAILABLE');
 expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([{ backendUrl:'file:///etc' }, { backendUrl:'https://user:pass@host' }, { backendUrl:'https://host/path' }, { backendUrl:'https://host?query=1' }, { workerIdentityToken:'' }, { timeoutMs:0 }])('rejects invalid trusted configuration %j', extra => {
 expect(() => createCanonicalWriteRecheckClient({ ...options, ...extra })).toThrow();
});
it('rejects malformed scope or missing token before sending identity', async () => {
 const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); const check = createCanonicalWriteRecheckClient(options);
 await expect(check({ ...scope, relativePath:'../outside' }, 'token')).rejects.toThrow();
 await expect(check(scope, '')).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
});
