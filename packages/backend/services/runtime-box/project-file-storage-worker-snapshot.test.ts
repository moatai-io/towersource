import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRemoteWorkbenchWorkerServer } from '../execution/worker/worker-server.js';
import { collectWorkerStorageSnapshot } from './project-file-storage-worker-snapshot.js';
import { collectHostStorageSnapshot } from './project-file-storage-collector.js';
import { planProjectFileStoragePreflight } from './project-file-storage-preflight.js';
import { getPersistedWorkbenchWorker } from '../execution/worker/worker-repository.js';
vi.mock('../execution/worker/worker-repository.js', () => ({ getPersistedWorkbenchWorker: vi.fn() }));
vi.mock('../execution/worker/worker-transport-credentials.js', () => ({ resolveWorkbenchWorkerTransportToken: vi.fn(async () => 'synthetic-test-token') }));
let root: string; let server: http.Server; let baseUrl: string;
const input = { projectId: 'p', deploymentId: 'test', workerId: 'w', actorUserId: 1 };
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-worker-test-'));
  server = createRemoteWorkbenchWorkerServer({ enableStoragePreflight: true, workerId: 'w', token: 'synthetic-test-token', projects: { p: root } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  vi.mocked(getPersistedWorkbenchWorker).mockResolvedValue({ workerId: 'w', deploymentId: 'test', projectIds: ['p'], status: 'healthy', baseUrl } as any);
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); });
it('collects actual HTTP Worker evidence including folders omitted by legacy manifests', async () => {
  await fs.mkdir(path.join(root, '.git')); await fs.writeFile(path.join(root, '.git', 'fixture'), 'hello');
  const host = collectHostStorageSnapshot({ ...input, rootPath: root });
  const worker = await collectWorkerStorageSnapshot(input);
  expect(worker.entries).toEqual(host.entries);
  expect(planProjectFileStoragePreflight({ ...input, host, worker, target: worker.source, now: Date.now() })).toMatchObject({ status: 'content-matched', readyToActivate: false });
});
it('strict mode rejects symlinks rather than silently omitting them', async () => {
  await fs.symlink('/etc', path.join(root, 'outside'));
  await expect(collectWorkerStorageSnapshot(input)).rejects.toThrow('HTTP_400');
});
it('retains authentication and project allowlist at the strict endpoint', async () => {
  expect((await fetch(`${baseUrl}/v1/files/p/manifest?path=.&mode=storage-preflight-v1`)).status).toBe(401);
  expect((await fetch(`${baseUrl}/v1/files/other/manifest?path=.&mode=storage-preflight-v1`, { headers: { authorization: 'Bearer synthetic-test-token' } })).status).toBe(403);
});
it('rejects scope mismatch before issuing a file request', async () => {
  vi.mocked(getPersistedWorkbenchWorker).mockResolvedValue({ deploymentId: 'test', projectIds: [], status: 'healthy' } as any);
  await expect(collectWorkerStorageSnapshot(input)).rejects.toThrow('AUTHORITY_UNAVAILABLE');
});
