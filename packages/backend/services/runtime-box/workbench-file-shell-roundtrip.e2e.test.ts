import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn() }));
vi.mock('../execution/worker/worker-repository.js', () => ({ getPersistedWorkbenchWorker: vi.fn() }));
vi.mock('../execution/worker/worker-transport-credentials.js', () => ({ resolveWorkbenchWorkerTransportToken: vi.fn(async () => 'synthetic-roundtrip-token') }));
import { createRemoteWorkbenchWorkerServer } from '../execution/worker/worker-server.js';
import { createRemoteWorkbenchHttpTransport } from '../execution/worker/worker-http-transport.js';
import { createWorkerProjectDirectory, writeWorkerProjectFile, type WorkerFileAuthority } from './workbench-project-file-authority.js';

let root: string | undefined;
let server: http.Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  if (root) await fs.rm(root, { recursive: true, force: true });
});

it('supports file-authority and bash writes in both directions on the same native Worker', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-file-shell-test-'));
  const token = 'synthetic-roundtrip-token';
  server = createRemoteWorkbenchWorkerServer({ workerId: 'w', token, projects: { p: root } });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listen failed');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const authority: WorkerFileAuthority = { projectId: 'p', projectRoot: root, relativePath: 'from-file-tool', workerId: 'w', workerBaseUrl: baseUrl };
  await createWorkerProjectDirectory({ authority, actorUserId: 7 });
  await writeWorkerProjectFile({ authority: { ...authority, relativePath: 'from-file-tool/a.txt' }, actorUserId: 7, content: 'file-tool' });
  const transport = createRemoteWorkbenchHttpTransport({ workerId: 'w', baseUrl, token });
  const result = await transport.execute({
    spec: { jobId: 42, projectId: 'p', actorUserId: 7, command: 'set -eu; test -w from-file-tool; printf shell >> from-file-tool/a.txt; mkdir from-shell; printf shell > from-shell/b.txt', timeoutSec: 10, workbenchRevision: null, environmentKeys: [] },
    credentials: {}, signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
  });
  expect(result.execResult.exit_code).toBe(0);
  expect(await fs.readFile(path.join(root, 'from-file-tool/a.txt'), 'utf8')).toBe('file-toolshell');
  await writeWorkerProjectFile({ authority: { ...authority, relativePath: 'from-shell/b.txt' }, actorUserId: 7, content: 'file-tool-replaced' });
  expect(await fs.readFile(path.join(root, 'from-shell/b.txt'), 'utf8')).toBe('file-tool-replaced');
  const a = await fs.stat(path.join(root, 'from-file-tool'));
  const b = await fs.stat(path.join(root, 'from-shell'));
  expect(a.uid).toBe(b.uid);
  expect(a.gid).toBe(b.gid);
  // Same-UID native characterization only: not proof of deployed UID mappings,
  // browser/AI tool routing, Skill mounts, or multi-user isolation.
});
