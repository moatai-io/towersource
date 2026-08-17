import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRemoteWorkbenchWorkerServer } from './remote-workbench-worker-server.js';
import { createRemoteWorkbenchHttpTransport } from './workbench-remote-http-transport.js';

const servers: http.Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-remote-worker-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'work'), { recursive: true });
  await fs.writeFile(path.join(root, 'work', 'input.txt'), 'mounted-workspace\n');
  const token = 'test-worker-token';
  process.env.TOWER_WORKER_BWRAP_BIN = '/usr/bin/bwrap';
  const server = createRemoteWorkbenchWorkerServer({ workerId: 'worker-e2e', token, projects: { 'project-a': root } });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('worker listen failed');
  return {
    root,
    transport: createRemoteWorkbenchHttpTransport({ workerId: 'worker-e2e', baseUrl: `http://127.0.0.1:${address.port}`, token }),
  };
}

const baseSpec = {
  jobId: 1, projectId: 'project-a', command: 'cat work/input.txt', cwd: '/workspace',
  timeoutSec: 10, workbenchRevision: 3, environmentKeys: [],
};

describe('Remote Workbench HTTP transport localhost E2E', () => {
  it('executes in a separately listening Worker and streams mounted-workspace output', async () => {
    const { root, transport } = await fixture();
    const stdout: string[] = [];
    const result = await transport.execute({
      spec: {
        ...baseSpec,
        command: "cat work/input.txt; printf 'artifact-from-worker\\n' > work/output.txt",
        artifacts: [{ path: 'work/output.txt' }],
      },
      signal: new AbortController().signal,
      onStdout: chunk => stdout.push(chunk), onStderr: () => {},
    });
    expect(stdout.join('')).toBe('mounted-workspace\n');
    expect(result).toMatchObject({
      execResult: { exit_code: 0, timed_out: false, runtime_context: { project_id: 'project-a' } },
      artifacts: [{ path: 'work/output.txt', sizeBytes: 21, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }],
      cancellation: { requested: false, processGroupExited: true },
    });
    await expect(fs.readFile(path.join(root, 'work', 'output.txt'), 'utf8')).resolves.toBe('artifact-from-worker\n');
  });

  it('injects one run-scoped Credential and redacts it from streamed and terminal output', async () => {
    const { transport } = await fixture();
    const stdout: string[] = [];
    const secret = 'unique-secret-for-redaction';
    const result = await transport.execute({
      spec: { ...baseSpec, command: "printf '%s' \"$API_TOKEN\"", environmentKeys: ['API_TOKEN'] },
      credentials: { API_TOKEN: secret }, signal: new AbortController().signal,
      onStdout: chunk => stdout.push(chunk), onStderr: () => {},
    });
    expect(stdout.join('')).toBe('[REDACTED]');
    expect(result.execResult.stdout).toBe('[REDACTED]');
    expect(result.execResult.runtime_context.credential_env).toMatchObject({
      injected: [{ credential_id: 'run-scoped', env_name: 'API_TOKEN' }], suppressed: false,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('redacts a Credential on timeout and does not write a completion artifact', async () => {
    const { root, transport } = await fixture();
    const secret = 'timeout-secret-value';
    const result = await transport.execute({
      spec: { ...baseSpec, command: "printf '%s\\n' \"$API_TOKEN\"; sleep 2; printf done > work/timeout-should-not-exist.txt", timeoutSec: 1, environmentKeys: ['API_TOKEN'] },
      credentials: { API_TOKEN: secret }, signal: new AbortController().signal,
      onStdout: () => {}, onStderr: () => {},
    });
    expect(result.execResult).toMatchObject({ exit_code: 124, timed_out: true, stdout: '[REDACTED]\n' });
    expect(JSON.stringify(result)).not.toContain(secret);
    await expect(fs.access(path.join(root, 'work', 'timeout-should-not-exist.txt'))).rejects.toThrow();
  });

  it('fails closed when the Worker has no bwrap runtime configured', async () => {
    const previous = process.env.TOWER_WORKER_BWRAP_BIN;
    delete process.env.TOWER_WORKER_BWRAP_BIN;
    try {
      const { transport } = await fixture();
      delete process.env.TOWER_WORKER_BWRAP_BIN;
      await expect(transport.execute({
        spec: baseSpec, signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
      })).rejects.toThrow('REMOTE_WORKER_HTTP_400');
    } finally {
      if (previous === undefined) delete process.env.TOWER_WORKER_BWRAP_BIN;
      else process.env.TOWER_WORKER_BWRAP_BIN = previous;
    }
  });

  it('rejects a Credential key mismatch before execution', async () => {
    const { transport } = await fixture();
    await expect(transport.execute({
      spec: { ...baseSpec, environmentKeys: ['API_TOKEN'] }, credentials: { OTHER_TOKEN: 'hidden' },
      signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
    })).rejects.toThrow('REMOTE_WORKER_HTTP_400');
  });

  it('keeps ordinary runtime identity and DNS configuration available without exposing host home paths', async () => {
    const { transport } = await fixture();
    const result = await transport.execute({
      spec: {
        ...baseSpec,
        command: "test -r /etc/passwd && test -r /etc/resolv.conf && test -d /etc/ssl && test ! -e /home/tower-private && printf runtime-ok",
      },
      signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
    });
    expect(result.execResult).toMatchObject({ exit_code: 0, stdout: 'runtime-ok' });
  });

  it('cannot read Tower host files or another Project outside /workspace', async () => {
    const { transport } = await fixture();
    const result = await transport.execute({
      spec: {
        ...baseSpec,
        command: "test ! -e /home/tower/tower/.env && test ! -e /home/tower/workspace/projects/other-project && test -r /workspace/work/input.txt && printf isolated",
      },
      signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
    });
    expect(result.execResult).toMatchObject({ exit_code: 0, stdout: 'isolated' });
  });

  it('rejects a project that is not in the Worker-owned allowlist', async () => {
    const { transport } = await fixture();
    await expect(transport.execute({
      spec: { ...baseSpec, projectId: 'other-project' }, signal: new AbortController().signal,
      onStdout: () => {}, onStderr: () => {},
    })).rejects.toThrow('REMOTE_WORKER_HTTP_400');
  });

  it('keeps a managed background process alive after the control shell exits', async () => {
    const { root, transport } = await fixture();
    const result = await transport.execute({
      spec: {
        ...baseSpec,
        command: "mkdir -p .worker-service; nohup sh -c 'sleep 0.3; printf service-alive > .worker-service/alive.txt' >/dev/null 2>&1 </dev/null & printf '%s' $!",
      },
      signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
    });
    expect(result.execResult.exit_code).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 700));
    await expect(fs.readFile(path.join(root, '.worker-service', 'alive.txt'), 'utf8')).resolves.toBe('service-alive');
  });

  it('aborts the remote process group and prevents its completion artifact', async () => {
    const { root, transport } = await fixture();
    const controller = new AbortController();
    const stdout: string[] = [];
    const running = transport.execute({
      spec: { ...baseSpec, command: "printf 'started\\n'; sleep 5; printf done > work/should-not-exist.txt" },
      signal: controller.signal,
      onStdout: chunk => stdout.push(chunk), onStderr: () => {},
    });
    while (!stdout.join('').includes('started')) await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise(resolve => setTimeout(resolve, 700));
    await expect(fs.access(path.join(root, 'work', 'should-not-exist.txt'))).rejects.toThrow();
  });
});
