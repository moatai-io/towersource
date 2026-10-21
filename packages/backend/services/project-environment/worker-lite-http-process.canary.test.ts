import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRemoteWorkbenchWorkerServer } from '../execution/worker/worker-server.js';
import { createRemoteWorkbenchHttpTransport } from '../execution/worker/worker-http-transport.js';

const servers: http.Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-worker-lite-canary-'));
  roots.push(projectsRoot);
  const staticRoot = path.join(projectsRoot, 'static-project');
  const canonicalRoot = path.join(projectsRoot, 'canonical-project');
  await fs.mkdir(staticRoot, { recursive: true });
  await fs.mkdir(canonicalRoot, { recursive: true });
  await fs.writeFile(path.join(canonicalRoot, 'backend.txt'), 'canonical-bytes\n');
  const token = 'worker-lite-canary-token';
  const server = createRemoteWorkbenchWorkerServer({
    workerId: 'shared-worker-01', token, projectsRoot,
    projects: { 'static-project': staticRoot },
    isolationProfile: 'legacy-skill-dependent',
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('worker listen failed');
  return {
    canonicalRoot,
    transport: createRemoteWorkbenchHttpTransport({
      workerId: 'shared-worker-01', baseUrl: `http://127.0.0.1:${address.port}`,
      token, projectRoot: canonicalRoot,
    }),
  };
}

function execute(transport: Awaited<ReturnType<typeof fixture>>['transport'], input: { jobId: number; command: string; lifecycle?: 'service-control' }) {
  return transport.execute({
    spec: {
      jobId: input.jobId, projectId: 'canonical-project', actorUserId: 7,
      sessionId: '11111111-1111-4111-8111-111111111111', command: input.command,
      cwd: '/workspace', timeoutSec: 10, workbenchRevision: null, environmentKeys: [],
      ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
    },
    credentials: {}, signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
  });
}

describe('Worker-lite HTTP/process canary', () => {
  it('executes an unscoped canonical Project and round-trips the same workspace bytes', async () => {
    const { canonicalRoot, transport } = await fixture();
    const result = await execute(transport, {
      jobId: 1,
      command: "set -eu; test \"$(cat backend.txt)\" = canonical-bytes; printf worker-bytes > worker.txt; cat worker.txt",
    });
    expect(result.execResult).toMatchObject({ exit_code: 0, stdout: 'worker-bytes' });
    await expect(fs.readFile(path.join(canonicalRoot, 'worker.txt'), 'utf8')).resolves.toBe('worker-bytes');
  });

  it('starts, observes, and stops a managed process through authenticated service control', async () => {
    const { canonicalRoot, transport } = await fixture();
    const start = await execute(transport, {
      jobId: 2, lifecycle: 'service-control',
      command: "set -eu; mkdir -p .worker-service; nohup sh -c 'while :; do echo tick; sleep 0.1; done' > .worker-service/canary.log 2>&1 < /dev/null & echo $! > .worker-service/canary.pid; sleep 0.2; kill -0 \"$(cat .worker-service/canary.pid)\"; cat .worker-service/canary.pid",
    });
    expect(start.execResult.exit_code).toBe(0);
    const pid = Number(start.execResult.stdout.trim());
    expect(pid).toBeGreaterThan(0);

    const logs = await execute(transport, {
      jobId: 3, lifecycle: 'service-control',
      command: 'set -eu; test -s .worker-service/canary.log; tail -n 5 .worker-service/canary.log',
    });
    expect(logs.execResult.exit_code).toBe(0);
    expect(logs.execResult.stdout).toContain('tick');

    const stop = await execute(transport, {
      jobId: 4, lifecycle: 'service-control',
      command: 'set -eu; PID=$(cat .worker-service/canary.pid); kill -TERM "$PID"; i=0; while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 20 ]; do sleep 0.05; i=$((i+1)); done; kill -0 "$PID" 2>/dev/null && kill -KILL "$PID" || true; rm -f .worker-service/canary.pid',
    });
    expect(stop.execResult.exit_code).toBe(0);
    await expect(fs.access(path.join(canonicalRoot, '.worker-service/canary.pid'))).rejects.toThrow();
  });
});
