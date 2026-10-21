const keys = generateKeyPairSync('ed25519');
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import http from 'node:http';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const facts = vi.hoisted(() => ({ auth: vi.fn(), member: vi.fn(), project: vi.fn(), storage: vi.fn(), identity: vi.fn(), target: vi.fn() }));
vi.mock('./canonical-write-target.js', () => ({ resolveCanonicalWriteTarget: facts.target }));
vi.mock('../../config.js', () => ({ config: { jwtSecret: 'synthetic-two-server-jwt' } }));
vi.mock('../runtime-box/workbench-worker-identity-repository.js', () => ({ assertWorkbenchWorkerIdentityActive: facts.identity }));
vi.mock('../auth/auth.js', () => ({ getUserAuthState: facts.auth, authMiddleware: vi.fn(), adminMiddleware: vi.fn() }));
vi.mock('../pm/project-membership-manager.js', () => ({ isProjectMember: facts.member }));
vi.mock('../pm/project-manager.js', () => ({ getProject: facts.project }));
vi.mock('../runtime-box/workbench-project-file-authority.js', () => ({ resolveWorkerFileAuthorityForHostPath: facts.storage }));
// Path policy is separately tested against production rules; temp roots are not registered workspace roots.
vi.mock('../pm/project-access.js', () => ({ isDotfileDenied: () => false, isPathWritableByRole: async () => true }));
import { createCanonicalWriteRecheckRouter } from '../../routes/workbench-worker-api.js';
import { createCanonicalWriteRecheckClient } from '../runtime-box/canonical-write-recheck-client.js';
import { issueWorkbenchWorkerIdentity } from '../runtime-box/workbench-worker-identity.js';
import { delegateCanonicalTextWrite } from './canonical-text-delegation.js';
import { resolveProjectWorkspaceFile, readProjectWorkspaceFileBytes, writeProjectWorkspaceText, type ProjectWorkspaceFileReference } from './project-workspace-files.js';
import { createRemoteWorkbenchWorkerServer } from '../execution/worker/worker-server.js';
import { createCanonicalWriteReplayStore } from '../runtime-box/canonical-write-replay-store.js';
import { WorkerMaintenanceGate } from '../runtime-box/worker-maintenance-gate.js';

// Actual gateway/transport/HTTP/publication/replay store. DB facts are fixtures.
// Real two-server HTTP callback and signature verification; DB/path facts remain fixtures.
let controller: http.Server;
let base: string; let root: string; let server: http.Server; let reference: ProjectWorkspaceFileReference;
let target: { workerId: string; baseUrl: string; secret: string; signingKey: KeyObject }; let gate: WorkerMaintenanceGate;
let calls: number; let revokeAtPublication: boolean;
beforeEach(async () => {
 vi.resetAllMocks(); calls = 0; revokeAtPublication = false;
 base = await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-chain-')); root = path.join(base, 'project');
 await fs.mkdir(root); const runtime = path.join(base, 'runtime'); await fs.mkdir(runtime, { mode: 0o700 });
 await fs.writeFile(path.join(root, 'a.txt'), 'original');
 facts.auth.mockResolvedValue({ disabled: false, approvalStatus: 'active', role: 'member' });
 facts.member.mockResolvedValue(true); facts.project.mockResolvedValue({ id: 'p', rootPath: root }); facts.storage.mockResolvedValue(undefined);
 reference = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'a.txt' });
 facts.identity.mockResolvedValue(undefined);
 const app = express(); app.use(express.json({ limit: '48kb' }));
 app.use('/api/workbench-workers', createCanonicalWriteRecheckRouter(keys.publicKey));
 controller = app.listen(0, '127.0.0.1'); await new Promise<void>(r => controller.once('listening', r));
 const callback = createCanonicalWriteRecheckClient({ backendUrl: `http://127.0.0.1:${(controller.address() as import('node:net').AddressInfo).port}`,
  workerIdentityToken: issueWorkbenchWorkerIdentity({ workerId:'w', projectIds:['p'], capabilities:['job'] }).token });
 gate = new WorkerMaintenanceGate();
 server = createRemoteWorkbenchWorkerServer({ workerId: 'w', token: 'synthetic-chain-secret', projects: {}, maintenanceGate: gate,
  canonicalFileWrites: { verificationKey: keys.publicKey, consume: await createCanonicalWriteReplayStore(runtime), authorize: async (scope, token) => {
   calls++;
   if (revokeAtPublication && calls === 2) facts.member.mockResolvedValue(false);
   await callback(scope, token);
  } },
 });
 await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
 target = { workerId: 'w', secret: 'synthetic-chain-secret', signingKey: keys.privateKey, baseUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}` };
});
afterEach(async () => { controller.closeAllConnections(); await new Promise<void>(r => controller.close(() => r())); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(base, { recursive: true, force: true }); });
const write = () => delegateCanonicalTextWrite({ reference, actorUserId: 7, content: '새 내용', target });
it('delegates actual writes and reads the same canonical bytes without static Worker membership', async () => {
 expect(await write()).toEqual({ storageKind: 'host', bytesWritten: Buffer.byteLength('새 내용') });
 expect(calls).toBe(2);
 expect((await readProjectWorkspaceFileBytes({ reference, actorUserId: 7, maxBytes: 1024 })).bytes.toString()).toBe('새 내용');
});
it('does not dispatch a revoked direct writer', async () => {
 facts.member.mockResolvedValue(false);
 await expect(write()).rejects.toThrow('ACCESS_REVOKED'); expect(calls).toBe(0);
 expect(await fs.readFile(reference.hostPath, 'utf8')).toBe('original');
});
it('does not dispatch a changed root', async () => {
 facts.project.mockResolvedValue({ id: 'p', rootPath: path.join(base, 'other') });
 await expect(write()).rejects.toThrow('STORAGE_CHANGED'); expect(calls).toBe(0);
 expect(await fs.readFile(reference.hostPath, 'utf8')).toBe('original');
});
it('rechecks actual gateway policy before publication when membership is revoked after dispatch', async () => {
 revokeAtPublication = true;
 await expect(write()).rejects.toThrow('CANONICAL_WRITE_DENIED'); expect(calls).toBe(2);
 expect(await fs.readFile(reference.hostPath, 'utf8')).toBe('original');
});
it('keeps canonical reads available during Worker maintenance without local write fallback', async () => {
 gate.acquire('test');
 await expect(write()).rejects.toThrow('CANONICAL_WRITE_UNAVAILABLE'); expect(calls).toBe(0);
 expect((await readProjectWorkspaceFileBytes({ reference, actorUserId: 7, maxBytes: 1024 })).bytes.toString()).toBe('original');
 gate.release('test'); await expect(write()).resolves.toMatchObject({ storageKind: 'host' });
});

it('denies a revoked Worker identity without publishing bytes', async () => {
 facts.identity.mockRejectedValue(new Error('identity revoked'));
 await expect(write()).rejects.toThrow('CANONICAL_WRITE_DENIED');
 expect(await fs.readFile(reference.hostPath, 'utf8')).toBe('original');
});
it('denies writes when the Backend callback is unavailable, with no local fallback', async () => {
 controller.closeAllConnections(); await new Promise<void>(r => controller.close(() => r()));
 await expect(write()).rejects.toThrow('CANONICAL_WRITE_DENIED');
 expect(await fs.readFile(reference.hostPath, 'utf8')).toBe('original');
});

it('routes actual gateway text writes through both HTTP servers and preserves host reads',async()=>{
 facts.target.mockResolvedValue(target);
 expect(await writeProjectWorkspaceText({reference,actorUserId:7,content:'gateway write'})).toBe('host');
 expect(calls).toBe(2); expect(await fs.readFile(reference.hostPath,'utf8')).toBe('gateway write');
 gate.acquire('maintenance');
 await expect(writeProjectWorkspaceText({reference,actorUserId:7,content:'blocked'})).rejects.toThrow('UNAVAILABLE');
 expect(await fs.readFile(reference.hostPath,'utf8')).toBe('gateway write');
});
