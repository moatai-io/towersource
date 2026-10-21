import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRemoteWorkbenchWorkerServer } from '../../execution/worker/worker-server.js';
import { issueWorkbenchAuthorizationReceipt } from '../../runtime-box/workbench-authorization-receipt.js';
import { createRemoteWorkbenchHttpTransport } from '../../execution/worker/worker-http-transport.js';

const servers: http.Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function workerFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-authority-acceptance-'));
  roots.push(root);
  const token = 'acceptance-worker-transport-token';
  const server = createRemoteWorkbenchWorkerServer({ workerId: 'acceptance-worker', token, projects: { 'project-a': root }, bwrapBin: '/usr/bin/bwrap' });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('worker listen failed');
  return { root, token, transport: createRemoteWorkbenchHttpTransport({ workerId: 'acceptance-worker', baseUrl: `http://127.0.0.1:${address.port}`, token }) };
}

const spec = {
  jobId: 81,
  projectId: 'project-a',
  actorUserId: 7,
  sessionId: '11111111-1111-4111-8111-111111111111',
  command: 'true',
  cwd: '/workspace',
  timeoutSec: 5,
  workbenchRevision: 3,
  environmentKeys: [] as string[],
};
const callbacks = { signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {} };

describe('Remote Worker authorization and Credential boundary acceptance', () => {
  it('accepts a valid narrowed receipt once and rejects replay', async () => {
    const { token, transport } = await workerFixture();
    const receipt = issueWorkbenchAuthorizationReceipt({
      secret: token,
      actorUserId: spec.actorUserId,
      projectId: spec.projectId,
      sessionId: spec.sessionId,
      jobId: spec.jobId,
      environmentKeys: [],
    });
    await expect(transport.execute({ spec, authorizationReceipt: receipt, ...callbacks })).resolves.toMatchObject({ execResult: { exit_code: 0 } });
    await expect(transport.execute({ spec, authorizationReceipt: receipt, ...callbacks })).rejects.toThrow(/already consumed/);
  });

  it.each([
    ['project', { projectId: 'project-b' }],
    ['actor', { actorUserId: 8 }],
    ['job', { jobId: 82 }],
  ] as const)('rejects a receipt whose %s scope differs from the run', async (_label, overrides) => {
    const { token, transport } = await workerFixture();
    const receipt = issueWorkbenchAuthorizationReceipt({
      secret: token,
      actorUserId: spec.actorUserId,
      projectId: spec.projectId,
      sessionId: spec.sessionId,
      jobId: spec.jobId,
      environmentKeys: [],
    });
    await expect(transport.execute({ spec: { ...spec, ...overrides }, authorizationReceipt: receipt, ...callbacks })).rejects.toThrow(/authorization receipt/i);
  });

  it('materializes only a path for a file Credential, redacts content, and cleans normal and timeout runs', async () => {
    const { root, transport } = await workerFixture();
    const secret = 'acceptance-file-secret';
    const payload = Buffer.from(JSON.stringify({ envName: 'CONFIG_PATH', fileName: 'config.json', mode: '0600', credentialType: 'json', value: secret }), 'utf8').toString('base64');
    const environmentKeys = ['TOWER_REMOTE_FILE_CREDENTIAL_0'];
    const normal = await transport.execute({
      spec: { ...spec, command: "test -z \"${TOWER_REMOTE_FILE_CREDENTIAL_0-}\"; test -f \"$CONFIG_PATH\"; printf 'mode=%s value=%s' \"$(stat -c %a \"$CONFIG_PATH\")\" \"$(cat \"$CONFIG_PATH\")\"", environmentKeys },
      credentials: { TOWER_REMOTE_FILE_CREDENTIAL_0: payload },
      ...callbacks,
    });
    expect(normal.execResult).toMatchObject({ exit_code: 0, stdout: 'mode=600 value=[REDACTED]' });
    expect(JSON.stringify(normal)).not.toContain(secret);
    await expect(fs.access(path.join(root, '.tower-run-credentials'))).rejects.toThrow();

    const timedOut = await transport.execute({
      spec: { ...spec, jobId: 83, command: 'test -f "$CONFIG_PATH" && sleep 2', timeoutSec: 1, environmentKeys },
      credentials: { TOWER_REMOTE_FILE_CREDENTIAL_0: payload },
      ...callbacks,
    });
    expect(timedOut.execResult).toMatchObject({ exit_code: 124, timed_out: true });
    await expect(fs.access(path.join(root, '.tower-run-credentials'))).rejects.toThrow();
  });
});
