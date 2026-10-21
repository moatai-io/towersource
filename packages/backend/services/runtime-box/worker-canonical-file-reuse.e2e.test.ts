import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createRemoteWorkbenchWorkerServer } from '../execution/worker/worker-server.js';
import { createRemoteWorkbenchHttpTransport } from '../execution/worker/worker-http-transport.js';
import { WorkerMaintenanceGate } from './worker-maintenance-gate.js';

// Characterization of existing components, not a new canonical storage binding.
// All processes use the test OS user. This does NOT prove separate-user access,
// installed-executor identity, browser authorization, or team isolation.
const token = 'synthetic-file-reuse-token';
let root: string;
let server: http.Server | undefined;
let url: string;
let gate: WorkerMaintenanceGate;
async function start(projects: Record<string, string> = { 'project-a': root }) {
  gate = new WorkerMaintenanceGate();
  server = createRemoteWorkbenchWorkerServer({ workerId: 'reuse-test', token, projects, maintenanceGate: gate });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
}
async function stop() {
  if (!server) return;
  const current = server; server = undefined;
  current.closeAllConnections();
  await new Promise<void>((resolve, reject) => current.close(error => error ? reject(error) : resolve()));
}
async function put(value: string) {
  const response = await fetch(`${url}/v1/files/project-a/content?path=shared.txt&text-mode=replace`, {
    method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-length': String(Buffer.byteLength(value)) }, body: value,
  });
  return { status: response.status, body: await response.text() };
}
async function run(command: string) {
  const transport = createRemoteWorkbenchHttpTransport({ workerId: 'reuse-test', token, baseUrl: url });
  return transport.execute({ spec: { jobId: 1, projectId: 'project-a', actorUserId: 7,
    sessionId: '11111111-1111-4111-8111-111111111111', command, cwd: '/workspace', timeoutSec: 5,
    workbenchRevision: null, environmentKeys: [],
  }, signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {} });
}
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'canonical-reuse-')); });
afterEach(async () => { await stop(); await fs.rm(root, { recursive: true, force: true }); });
it('uses the same local bytes for HTTP write, native command edit, replacement and direct read', async () => {
  await start();
  expect((await put('first')).status).toBe(200);
  const initial = await fs.stat(path.join(root, 'shared.txt'));
  expect((await run("printf edited > shared.txt; printf created > command-created.txt")).execResult.exit_code).toBe(0);
  expect(await fs.readFile(path.join(root, 'shared.txt'), 'utf8')).toBe('edited');
  expect((await fs.stat(path.join(root, 'shared.txt'))).uid).toBe(initial.uid);
  expect((await fs.stat(path.join(root, 'command-created.txt'))).uid).toBe(initial.uid);
  expect((await put('replacement')).status).toBe(200);
  const response = await fetch(`${url}/v1/files/project-a/content?path=shared.txt`, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(await fs.readFile(path.join(root, 'shared.txt'), 'utf8'));
});
it('keeps file writes available after a command failure', async () => {
  await start();
  expect((await run('exit 7')).execResult.exit_code).toBe(7);
  expect((await put('after-failure')).status).toBe(200);
});
it('maintenance fences HTTP files but does not remove locally readable bytes', async () => {
  await start(); await put('preserved');
  expect(gate.acquire('test-maintenance')).toBe(true);
  expect((await put('blocked')).status).toBe(503);
  expect(await fs.readFile(path.join(root, 'shared.txt'), 'utf8')).toBe('preserved');
  expect(gate.release('test-maintenance')).toBe(true);
  expect((await put('resumed')).status).toBe(200);
});
it('preserves bytes across service stop and restart but cannot accept writes while stopped', async () => {
  await start(); await put('preserved'); await stop();
  await expect(put('unavailable')).rejects.toThrow();
  expect(await fs.readFile(path.join(root, 'shared.txt'), 'utf8')).toBe('preserved');
  await start(); expect((await put('restarted')).status).toBe(200);
});
it('does not infer file admission from a readable host directory', async () => {
  await start({});
  expect((await put('denied')).status).toBe(403);
  await expect(fs.stat(path.join(root, 'shared.txt'))).rejects.toThrow();
});
