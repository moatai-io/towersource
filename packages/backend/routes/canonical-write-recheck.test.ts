import express from 'express';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ active: vi.fn(), recheck: vi.fn() }));
vi.mock('../services/runtime-box/workbench-worker-identity-repository.js', () => ({ assertWorkbenchWorkerIdentityActive: mocks.active }));
vi.mock('../services/project-environment/canonical-text-delegation.js', () => ({ recheckCanonicalTextWrite: mocks.recheck }));
vi.mock('../config.js', () => ({ config: { jwtSecret: 'synthetic-recheck-test' } }));
import { createCanonicalWriteRecheckClient } from '../services/runtime-box/canonical-write-recheck-client.js';
import type { CanonicalFileWriteScope } from '../services/runtime-box/canonical-file-write-grant.js';
import { createCanonicalWriteRecheckRouter } from './workbench-worker-api.js';
import { issueWorkbenchWorkerIdentity } from '../services/runtime-box/workbench-worker-identity.js';
const keys = generateKeyPairSync('ed25519');
let server: http.Server; let url: string;
const scope = { workerId: 'w', projectId: 'p', projectRoot: '/work/p', actorUserId: 7, relativePath: 'a.txt', mode: 'replace', bytes: 3, bodySha256: 'a'.repeat(64) };
beforeEach(() => { vi.resetAllMocks(); mocks.active.mockResolvedValue(undefined); mocks.recheck.mockResolvedValue(undefined); });
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } });
async function start(enabled = true) { const app = express(); app.use(express.json({ limit: '48kb' })); app.use('/api/workbench-workers', createCanonicalWriteRecheckRouter(enabled ? keys.publicKey : undefined)); server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/workbench-workers/canonical-write/recheck`; }
async function post(body: unknown = { token: 'signed-token', scope }, bearer?: string) {
 const identity = issueWorkbenchWorkerIdentity({ workerId: 'w', projectIds: ['p'], capabilities: ['job'] });
 const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer ?? identity.token}` }, body: JSON.stringify(body) });
 return { status: response.status, text: await response.text() };
}
it('is disabled without an installation verification key', async () => { await start(false); expect((await post()).status).toBe(404); expect(mocks.active).not.toHaveBeenCalled(); expect(mocks.recheck).not.toHaveBeenCalled(); });
it('passes only middleware-authenticated identity to current authorization', async () => { await start(); expect((await post()).status).toBe(204); expect(mocks.recheck).toHaveBeenCalledWith({ authenticatedWorkerId: 'w', verificationKey: keys.publicKey, token: 'signed-token', scope }); });
it.each([{ actorUserId: 99 }, { role: 'admin' }, { workerId: 'other' }, { verificationKey: 'supplied' }])('rejects caller authority fields %j', async extra => { await start(); expect((await post({ token: 'signed-token', scope, ...extra })).status).toBe(400); expect(mocks.recheck).not.toHaveBeenCalled(); });
it('rejects inactive or non-Worker identity', async () => { await start(); expect((await post(undefined, 'browser-like-token')).status).toBe(401); mocks.active.mockRejectedValue(new Error('inactive')); expect((await post()).status).toBe(401); expect(mocks.recheck).not.toHaveBeenCalled(); });
it('does not expose internal diagnostics on failed recheck', async () => { await start(); mocks.recheck.mockRejectedValue(new Error('private SQL or policy failure')); const result = await post(); expect(result.status).toBe(403); expect(result.text).not.toContain('private'); });
it('rejects invalid path and unknown scope fields before the service', async () => { await start(); expect((await post({ token:'x',scope:{...scope,relativePath:'../outside'} })).status).toBe(400); expect((await post({ token:'x',scope:{...scope,unknown:true} })).status).toBe(400); expect(mocks.recheck).not.toHaveBeenCalled(); });

it('accepts the actual Worker callback client through current identity middleware', async () => {
 await start();
 const identity = issueWorkbenchWorkerIdentity({ workerId:'w', projectIds:['p'], capabilities:['job'] });
 const callback = createCanonicalWriteRecheckClient({ backendUrl:new URL(url).origin, workerIdentityToken:identity.token });
 await callback(scope as CanonicalFileWriteScope, 'signed-token');
 expect(mocks.recheck).toHaveBeenCalledWith({ authenticatedWorkerId:'w', verificationKey:keys.publicKey, scope, token:'signed-token' });
 mocks.active.mockRejectedValue(new Error('revoked identity'));
 await expect(callback(scope as CanonicalFileWriteScope, 'signed-token')).rejects.toThrow('RECHECK_DENIED');
 expect(mocks.recheck).toHaveBeenCalledTimes(1);
});
