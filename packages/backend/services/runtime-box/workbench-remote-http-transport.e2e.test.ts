import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRemoteWorkbenchWorkerServer } from '../execution/worker/worker-server.js';
import { createRemoteWorkbenchHttpTransport } from '../execution/worker/worker-http-transport.js';
import { issueWorkbenchAuthorizationReceipt } from './workbench-authorization-receipt.js';
import { computeBundleDigest } from '../skill/skill-bundle-resolver.js';

const servers: http.Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(projections?: Record<string, string>, operatorGitIdentity?: { name: string; email: string }, managedSkillsRoot?: string, isolationProfile?: 'legacy-skill-dependent' | 'project-sandbox-v1', executorFactory?: (root: string) => import('./workstation-executor-capability.js').WorkstationExecutorCapability | undefined) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-remote-worker-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'work'), { recursive: true });
  await fs.writeFile(path.join(root, 'work', 'input.txt'), 'mounted-workspace\n');
  const token = 'test-worker-token';
  const server = createRemoteWorkbenchWorkerServer({ workerId: 'worker-e2e', token, ...(executorFactory ? { executionBackend: 'installed-executor' as const, executorCapabilities: new Map([['project-a', executorFactory(root)]].filter((x): x is [string, import('./workstation-executor-capability.js').WorkstationExecutorCapability] => Boolean(x[1]))) } : {}), projects: { 'project-a': root }, projections, operatorGitIdentity, managedSkillsRoot, isolationProfile, bwrapBin: '/usr/bin/bwrap' });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('worker listen failed');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    root,
    token,
    baseUrl,
    transport: createRemoteWorkbenchHttpTransport({ workerId: 'worker-e2e', baseUrl, token }),
  };
}

const baseSpec = {
  jobId: 1, projectId: 'project-a', actorUserId: 7, sessionId: '11111111-1111-4111-8111-111111111111',
  command: 'cat work/input.txt', cwd: '/workspace', timeoutSec: 10, workbenchRevision: 3, environmentKeys: [],
};

describe('Remote Workbench HTTP transport localhost E2E', () => {
  it('waits for a restarting Worker to listen, then dispatches the run exactly once', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-restarting-worker-'));
    roots.push(root);
    await fs.mkdir(path.join(root, 'work'), { recursive: true });
    const token = 'restarting-worker-token';
    const portProbe = http.createServer();
    await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve));
    const address = portProbe.address();
    if (!address || typeof address === 'string') throw new Error('port probe listen failed');
    const port = address.port;
    await new Promise<void>(resolve => portProbe.close(() => resolve()));

    const worker = createRemoteWorkbenchWorkerServer({
      workerId: 'restarting-worker', token, projects: { 'project-a': root },
      managedSkillsRoot: path.join(process.cwd(), 'skills'), bwrapBin: '/usr/bin/bwrap',
    });
    servers.push(worker);
    let runRequests = 0;
    worker.prependListener('request', request => { if (request.method === 'POST' && request.url === '/v1/runs') runRequests += 1; });
    const startWorker = setTimeout(() => worker.listen(port, '127.0.0.1'), 100);
    try {
      const transport = createRemoteWorkbenchHttpTransport({
        workerId: 'restarting-worker', baseUrl: `http://127.0.0.1:${port}`, token,
        readinessGraceMs: 2_000, readinessPollMs: 25,
      });
      await expect(transport.execute({
        spec: { ...baseSpec, command: "printf restarted > work/restarted.txt" },
        signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
      })).resolves.toMatchObject({ execResult: { exit_code: 0 } });
      expect(runRequests).toBe(1);
      await expect(fs.readFile(path.join(root, 'work', 'restarted.txt'), 'utf8')).resolves.toBe('restarted');
    } finally {
      clearTimeout(startWorker);
    }
  });

  it('expires readiness grace without sending a run POST', async () => {
    let runRequests = 0;
    const unavailable = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/v1/runs') runRequests += 1;
      response.statusCode = 503;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: false, workerId: 'unavailable-worker' }));
    });
    servers.push(unavailable);
    await new Promise<void>(resolve => unavailable.listen(0, '127.0.0.1', resolve));
    const address = unavailable.address();
    if (!address || typeof address === 'string') throw new Error('unavailable worker listen failed');
    const transport = createRemoteWorkbenchHttpTransport({
      workerId: 'unavailable-worker', baseUrl: `http://127.0.0.1:${address.port}`, token: 'unused-token',
      readinessGraceMs: 100, readinessPollMs: 25,
    });
    await expect(transport.execute({
      spec: baseSpec, signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
    })).rejects.toThrow('WORKER_UNREACHABLE: unavailable-worker; readiness not restored');
    expect(runRequests).toBe(0);
  });

  it('passes official GWS paths to the command and removes run credentials afterwards', async () => {
    const { root, transport } = await fixture();
    const source = path.join(root, 'synthetic-source');
    await fs.mkdir(path.join(source, 'gws'), { recursive: true });
    await fs.writeFile(path.join(source, 'gws', 'credentials.json'), JSON.stringify({ type: 'authorized_user', refresh_token: 'synthetic-agent-account' }), { mode: 0o600 });
    const credentials = {
      TOWER_REMOTE_GWS_CONFIG_B64: execFileSync('tar', ['-czf', '-', '-C', source, 'gws']).toString('base64'),
      TOWER_REMOTE_GWS_USER_ID: '7',
    };
    const result = await transport.execute({
      spec: { ...baseSpec, environmentKeys: Object.keys(credentials), command: 'set -eu; test "$XDG_CONFIG_HOME" = "$HOME/.config"; test "$GOOGLE_WORKSPACE_CLI_CONFIG_DIR" = "$GWS_CONFIG_HOME"; test "$GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE" = "$GWS_CONFIG_HOME/credentials.json"; test -r "$GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE"; test -z "${TOWER_REMOTE_GWS_CONFIG_B64:-}"; printf "%s" "$HOME" > work/gws-home.txt; printf gws-paths-ok' },
      credentials, signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
    });
    expect(result.execResult.exit_code).toBe(0);
    expect(result.execResult.stdout).toBe('gws-paths-ok');
    const home = await fs.readFile(path.join(root, 'work/gws-home.txt'), 'utf8');
    await expect(fs.access(home)).rejects.toThrow();
  });
  it('characterizes native same-UID access outside the Project without reading credential contents', async () => {
    const { root, transport } = await fixture();
    // Synthetic sibling only: never probe actual controller inputs or other Projects.
    const controllerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-synthetic-controller-'));
    roots.push(controllerRoot);
    const controllerInput = path.join(controllerRoot, 'identity.fixture');
    await fs.writeFile(controllerInput, 'synthetic-identity-not-a-credential', { mode: 0o600 });
    await fs.chmod(controllerRoot, 0o700);
    const result = await transport.execute({
      spec: { ...baseSpec, command: `test -r '${controllerInput}' && printf same-uid-readable; printf persistent > work/roundtrip.txt` },
      signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
    });
    expect(result.execResult.exit_code).toBe(0);
    expect(result.execResult.stdout).toBe('same-uid-readable');
    expect(JSON.stringify(result)).not.toContain('synthetic-identity-not-a-credential');
    expect(result.execResult.runtime_context).toMatchObject({ workstation: { filesystem_view: 'native' } });
    expect(await fs.readFile(path.join(root, 'work/roundtrip.txt'), 'utf8')).toBe('persistent');
    // This is a characterization of the existing gap, not desired isolation behavior.
  });

  it('uses an explicit sandbox without Skills, preserving identity and file round-trip', async () => {
    const { root, transport, baseUrl } = await fixture(undefined, undefined, undefined, 'project-sandbox-v1');
    const result = await transport.execute({
      spec: { ...baseSpec, command: 'set -eu; test "$(pwd)" = /workspace; id -un >/dev/null; ssh -G -F /dev/null example.invalid >/dev/null 2>&1; test -w "$HOME"; cat work/input.txt; printf sandbox > work/output.txt' },
      signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
    });
    expect(result.execResult).toMatchObject({ exit_code: 0, runtime_context: { workstation: { isolation_profile: 'project-sandbox-v1', filesystem_view: 'sandbox', persistent_home: true } } });
    await expect(fs.readFile(path.join(root, 'work/output.txt'), 'utf8')).resolves.toBe('sandbox');
    const ready = await (await fetch(`${baseUrl}/ready`)).json();
    expect(ready.isolationProfile).toBe('project-sandbox-v1');
    expect(ready.capabilities).not.toContain('service');
  });

  it('rejects legacy service control before running commands in the explicit sandbox', async () => {
    const { root, transport } = await fixture(undefined, undefined, undefined, 'project-sandbox-v1');
    await expect(transport.execute({
      spec: { ...baseSpec, lifecycle: 'service-control', command: 'touch work/should-not-run' },
      signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
    })).rejects.toThrow('WORKER_SERVICE_SUPERVISOR_REQUIRED');
    await expect(fs.access(path.join(root, 'work/should-not-run'))).rejects.toThrow();
  });

  it('owns background descendants until sandbox exit rather than leaking them', async () => {
    const { root, transport } = await fixture(undefined, undefined, undefined, 'project-sandbox-v1');
    const result = await transport.execute({
      spec: { ...baseSpec, command: "nohup sh -c 'sleep 0.3; echo leaked > work/leaked' >/dev/null 2>&1 </dev/null & echo returned" },
      signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
    });
    expect(result.execResult.exit_code).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 600));
    await expect(fs.access(path.join(root, 'work/leaked'))).rejects.toThrow();
  });

  it('reports managed skill projection readiness and runtime provenance', async () => {
    const { baseUrl } = await fixture(undefined, undefined, path.join(process.cwd(), 'skills'));
    const response = await fetch(`${baseUrl}/ready`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      workerId: 'worker-e2e',
      managedSkillsRootConfigured: true,
      bubblewrapAvailable: true,
      skillProjectionVersion: 1,
      capabilities: expect.arrayContaining(['managed-skill-projection-v1']),
    });
  });

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

  it('returns a manifest for the Project root while keeping file endpoints scoped', async () => {
    const { baseUrl, token } = await fixture();
    const response = await fetch(`${baseUrl}/v1/files/project-a/manifest?path=.&maxFiles=20`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      fileCount: 1,
      entries: expect.arrayContaining([
        expect.objectContaining({ path: 'work/input.txt', type: 'file', sizeBytes: 18 }),
      ]),
    });
    const fileResponse = await fetch(`${baseUrl}/v1/files/project-a/content?path=.`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(fileResponse.status).toBe(404);
  });

  it('executes a newly bound Project through a signed root grant without static Worker scope reload', async () => {
    const projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-granted-projects-'));
    roots.push(projectsRoot);
    const staticRoot = path.join(projectsRoot, 'static');
    const grantedRoot = path.join(projectsRoot, 'new-project');
    await fs.mkdir(staticRoot, { recursive: true });
    await fs.mkdir(grantedRoot, { recursive: true });
    await fs.writeFile(path.join(grantedRoot, 'hello.txt'), 'grant-ok\n');
    const token = 'grant-worker-token';
    const server = createRemoteWorkbenchWorkerServer({ workerId: 'worker-grant', token, projectsRoot, projects: { static: staticRoot }, bwrapBin: '/usr/bin/bwrap' });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('worker listen failed');
    const transport = createRemoteWorkbenchHttpTransport({ workerId: 'worker-grant', baseUrl: `http://127.0.0.1:${address.port}`, token, projectRoot: grantedRoot });
    const stdout: string[] = [];
    await expect(transport.execute({
      spec: { ...baseSpec, projectId: 'new-project', command: 'cat hello.txt' },
      signal: new AbortController().signal,
      onStdout: chunk => stdout.push(chunk), onStderr: () => {},
    })).resolves.toMatchObject({ execResult: { exit_code: 0 } });
    expect(stdout.join('')).toBe('grant-ok\n');
  });

  it('rejects a replayed authorization receipt', async () => {
    const { transport, token } = await fixture();
    const authorizationReceipt = issueWorkbenchAuthorizationReceipt({
      secret: token,
      actorUserId: baseSpec.actorUserId,
      projectId: baseSpec.projectId,
      sessionId: baseSpec.sessionId,
      jobId: baseSpec.jobId,
      environmentKeys: [],
    });
    const run = () => transport.execute({
      spec: baseSpec,
      authorizationReceipt,
      signal: new AbortController().signal,
      onStdout: () => {}, onStderr: () => {},
    });
    await expect(run()).resolves.toMatchObject({ execResult: { exit_code: 0 } });
    await expect(run()).rejects.toThrow(/already consumed/);
  });

  it('does not inherit Worker process secrets and only injects the run-scoped Credential with redaction', async () => {
    const sentinels = {
      TOWER_REMOTE_WORKER_TOKEN: 'worker-transport-sentinel',
      DATABASE_URL: 'postgresql://worker-process-sentinel',
      JWT_SECRET: 'worker-jwt-sentinel',
      SECRET_STORE_MASTER_KEY: 'worker-vault-sentinel',
    };
    const previous = Object.fromEntries(Object.keys(sentinels).map(key => [key, process.env[key]]));
    Object.assign(process.env, sentinels);
    try {
      const { transport } = await fixture();
      const stdout: string[] = [];
      const secret = 'unique-secret-for-redaction';
      const result = await transport.execute({
        spec: {
          ...baseSpec,
          command: "for key in TOWER_REMOTE_WORKER_TOKEN DATABASE_URL JWT_SECRET SECRET_STORE_MASTER_KEY; do eval 'value=${'\"$key\"'}'; test -z \"$value\" || exit 41; done; printf 'worker-secrets=missing\\nrun-credential=%s' \"$API_TOKEN\"",
          environmentKeys: ['API_TOKEN'],
        },
        credentials: { API_TOKEN: secret }, signal: new AbortController().signal,
        onStdout: chunk => stdout.push(chunk), onStderr: () => {},
      });
      expect(stdout.join('')).toBe('worker-secrets=missing\nrun-credential=[REDACTED]');
      expect(result.execResult).toMatchObject({ exit_code: 0, stdout: 'worker-secrets=missing\nrun-credential=[REDACTED]' });
      expect(result.execResult.runtime_context.credential_env).toMatchObject({
        injected: [{ credential_id: 'run-scoped', env_name: 'API_TOKEN' }], suppressed: false,
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      for (const value of Object.values(sentinels)) expect(JSON.stringify(result)).not.toContain(value);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it.each(['legacy-skill-dependent', 'project-sandbox-v1'] as const)('materializes and cleans a private file Credential in %s', async isolationProfile => {
    const { root, transport } = await fixture(undefined, undefined, undefined, isolationProfile);
    const payload = Buffer.from(JSON.stringify({ envName: 'CONFIG_PATH', fileName: 'config.json', mode: '0600', credentialType: 'json', value: 'generic-file-secret' }), 'utf8').toString('base64');
    const result = await transport.execute({
      spec: {
        ...baseSpec,
        command: "test -z \"${TOWER_REMOTE_FILE_CREDENTIAL_0-}\" || exit 41; test -f \"$CONFIG_PATH\" || exit 42; printf 'mode=%s|value=%s' \"$(stat -c %a \"$CONFIG_PATH\")\" \"$(cat \"$CONFIG_PATH\")\"",
        environmentKeys: ['TOWER_REMOTE_FILE_CREDENTIAL_0'],
      },
      credentials: { TOWER_REMOTE_FILE_CREDENTIAL_0: payload }, signal: new AbortController().signal,
      onStdout: () => {}, onStderr: () => {},
    });
    expect(result.execResult).toMatchObject({ exit_code: 0, stdout: 'mode=600|value=[REDACTED]' });
    expect(result.execResult.runtime_context.credential_env).toMatchObject({
      injected: [],
      materialized_files: [{ credential_id: 'run-scoped', env_name: 'CONFIG_PATH', kind: 'file' }],
    });
    expect(JSON.stringify(result)).not.toContain('generic-file-secret');
    const entries = await fs.readdir(path.join(root, '.tower-run-credentials')).catch(() => [] as string[]);
    expect(entries.filter(name => name.startsWith('file-'))).toEqual([]);
  });

  it('materializes an OpenSSH-compatible private key for Worker commands and removes it afterward', async () => {
    const { root, transport } = await fixture();
    const payload = Buffer.from(JSON.stringify({ envName: 'SSH_KEY_FILE', fileName: 'id_ssh', mode: '0600', credentialType: 'ssh_private_key', value: 'private-key-without-newline' }), 'utf8').toString('base64');
    const result = await transport.execute({
      spec: { ...baseSpec, command: "test \"$(tail -c 1 \"$SSH_KEY_FILE\" | od -An -t u1 | tr -d ' ')\" = 10 && test \"$(stat -c %a \"$SSH_KEY_FILE\")\" = 600 && test -z \"${TOWER_REMOTE_FILE_CREDENTIAL_0-}\"", environmentKeys: ['TOWER_REMOTE_FILE_CREDENTIAL_0'] },
      credentials: { TOWER_REMOTE_FILE_CREDENTIAL_0: payload }, signal: new AbortController().signal,
      onStdout: () => {}, onStderr: () => {},
    });
    expect(result.execResult).toMatchObject({ exit_code: 0 });
    expect(result.execResult.runtime_context.credential_env).toMatchObject({
      injected: [],
      materialized_files: [{ credential_id: 'run-scoped', env_name: 'SSH_KEY_FILE', kind: 'file' }],
    });
    const entries = await fs.readdir(path.join(root, '.tower-run-credentials')).catch(() => [] as string[]);
    expect(entries.filter(name => name.startsWith('file-'))).toEqual([]);
  });

  it('isolates same-basename Worker Credentials and cleans both files', async () => {
    const { root, transport } = await fixture();
    const credentials = Object.fromEntries(['FIRST_KEY_FILE', 'SECOND_KEY_FILE'].map((envName, index) => [
      `TOWER_REMOTE_FILE_CREDENTIAL_${index}`,
      Buffer.from(JSON.stringify({ envName, fileName: 'id_ssh', mode: '0600', credentialType: 'ssh_private_key', value: `synthetic-key-${index}` })).toString('base64'),
    ]));
    const result = await transport.execute({
      spec: { ...baseSpec, command: 'test "$FIRST_KEY_FILE" != "$SECOND_KEY_FILE" && test -s "$FIRST_KEY_FILE" && test -s "$SECOND_KEY_FILE" && ! cmp -s "$FIRST_KEY_FILE" "$SECOND_KEY_FILE"', environmentKeys: Object.keys(credentials) },
      credentials, signal: new AbortController().signal,
      onStdout: () => {}, onStderr: () => {},
    });
    expect(result.execResult.exit_code).toBe(0);
    await expect(fs.access(path.join(root, '.tower-run-credentials'))).rejects.toThrow();
  });

  it('cleans generic and Higgsfield files after timeout', async () => {
    const { root, transport } = await fixture();
    const oauth = JSON.stringify({ access_token: 'access-timeout', refresh_token: 'refresh-timeout' });
    const payload = Buffer.from(JSON.stringify({ envName: 'CONFIG_PATH', fileName: 'config.json', mode: '0600', credentialType: 'json', value: 'file-timeout' }), 'utf8').toString('base64');
    const result = await transport.execute({
      spec: { ...baseSpec, command: 'test -f "$CONFIG_PATH" && test -f "$HIGGSFIELD_CLI_CREDENTIALS_FILE" && sleep 2', timeoutSec: 1, environmentKeys: ['TOWER_REMOTE_FILE_CREDENTIAL_0', 'TOWER_REMOTE_HIGGSFIELD_CREDENTIALS_JSON'] },
      credentials: { TOWER_REMOTE_FILE_CREDENTIAL_0: payload, TOWER_REMOTE_HIGGSFIELD_CREDENTIALS_JSON: oauth }, signal: new AbortController().signal,
      onStdout: () => {}, onStderr: () => {},
    });
    expect(result.execResult).toMatchObject({ exit_code: 124, timed_out: true });
    const entries = await fs.readdir(path.join(root, '.tower-run-credentials')).catch(() => [] as string[]);
    expect(entries.filter(name => /^(file|higgsfield)-/.test(name))).toEqual([]);
  });

  it('does not scan or delete similarly named Project data while cleaning executor-private Credentials', async () => {
    const { root, transport } = await fixture();
    const projectData = path.join(root, '.tower-run-credentials', 'file-project-data');
    await fs.mkdir(projectData, { recursive: true });
    const result = await transport.execute({ spec: { ...baseSpec, command: 'true' }, signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {} });
    expect(result.execResult.exit_code).toBe(0);
    await expect(fs.access(projectData)).resolves.toBeUndefined();
  });

  it('materializes Higgsfield OAuth JSON as a private CLI file and cleans it after execution', async () => {
    const { root, transport } = await fixture();
    const oauth = JSON.stringify({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_at: '2099-01-01T00:00:00Z', token_type: 'Bearer' });
    const result = await transport.execute({
      spec: {
        ...baseSpec,
        command: "test -z \"${TOWER_REMOTE_HIGGSFIELD_CREDENTIALS_JSON-}\" || exit 41; test -f \"$HIGGSFIELD_CLI_CREDENTIALS_FILE\" || exit 42; printf 'mode=%s|home=%s' \"$(stat -c %a \"$HIGGSFIELD_CLI_CREDENTIALS_FILE\")\" \"$(basename \"$HOME\")\"",
        environmentKeys: ['TOWER_REMOTE_HIGGSFIELD_CREDENTIALS_JSON'],
      },
      credentials: { TOWER_REMOTE_HIGGSFIELD_CREDENTIALS_JSON: oauth }, signal: new AbortController().signal,
      onStdout: () => {}, onStderr: () => {},
    });
    expect(result.execResult).toMatchObject({ exit_code: 0, stdout: expect.stringMatching(/^mode=600\|home=higgsfield-/) });
    expect(result.execResult.runtime_context.credential_env).toMatchObject({
      injected: [],
      materialized_files: [{ credential_id: 'run-scoped', env_name: 'HIGGSFIELD_CLI_CREDENTIALS_FILE', kind: 'file' }],
    });
    expect(JSON.stringify(result)).not.toContain('access-secret');
    const credentialRoot = path.join(root, '.tower-run-credentials');
    const entries = await fs.readdir(credentialRoot).catch(() => [] as string[]);
    expect(entries.filter(name => name.startsWith('higgsfield-'))).toEqual([]);
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

  it('uses the Worker native shell and injects non-secret Tower session attribution', async () => {
    const { transport } = await fixture();
    const result = await transport.execute({
      spec: { ...baseSpec, command: "printf '%s|%s|%s' \"$TOWER_WORKSTATION_SHELL\" \"$HOME\" \"$TOWER_SESSION_ID\"" },
      signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
    });
    expect(result.execResult.stdout).toBe(`native|${process.env.HOME}|${baseSpec.sessionId}`);
    expect(result.execResult.runtime_context.workstation).toMatchObject({
      shell: 'native', persistent_home: true, host_tools: 'available', default_scope: 'current-project',
    });
  });

  it.each(['legacy-skill-dependent', 'project-sandbox-v1'] as const)('projects only manifest-listed managed skills read-only with NSS in %s', async isolationProfile => {
    const skillsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-worker-skills-'));
    roots.push(skillsRoot);
    const allowed = path.join(skillsRoot, 'image-gen');
    const blocked = path.join(skillsRoot, 'other-skill');
    await fs.mkdir(path.join(allowed, 'scripts'), { recursive: true });
    await fs.mkdir(blocked, { recursive: true });
    await fs.writeFile(path.join(allowed, 'SKILL.md'), '# image-gen');
    await fs.writeFile(path.join(allowed, 'skill.yaml'), 'name: image-gen\nversion: 1.0.0\n');
    await fs.writeFile(path.join(allowed, 'scripts', 'generate_image.py'), 'print("mounted")\n');
    await fs.writeFile(path.join(blocked, 'SKILL.md'), '# other');
    const files = await Promise.all(['SKILL.md', 'scripts/generate_image.py', 'skill.yaml'].map(async relativePath => {
      const content = await fs.readFile(path.join(allowed, relativePath));
      return { relativePath, sizeBytes: content.length, sha256: createHash('sha256').update(content).digest('hex') };
    }));
    const worker = await fixture(undefined, undefined, skillsRoot, isolationProfile);
    await fs.mkdir(path.join(worker.root, '.tower', 'skills', 'image-gen'), { recursive: true });
    await fs.writeFile(path.join(worker.root, '.tower', 'skills', 'image-gen', 'SKILL.md'), '# control-only');
    await fs.writeFile(path.join(worker.root, '.tower', 'skills', 'manifest.json'), JSON.stringify({
      schemaVersion: 3, managedBy: 'tower-project-skill-runtime-layer',
      skills: [{ name: 'image-gen', storageMode: 'bind-ro', bundleDigest: computeBundleDigest(files) }],
    }));
    // A corrupt sibling must not prevent ordinary commands or the healthy bundle.
    await fs.mkdir(path.join(worker.root, '.tower/skills/broken'), { recursive: true });
    await fs.writeFile(path.join(worker.root, '.tower/skills/broken/SKILL.md'), 'stale broken control');
    const manifestPath = path.join(worker.root, '.tower/skills/manifest.json');
    const mixedManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    mixedManifest.skills.push({ name: 'broken', bundleDigest: 'sha256:legacy-copy' });
    await fs.writeFile(manifestPath, JSON.stringify(mixedManifest));
    const isolated = await worker.transport.execute({
      spec: { ...baseSpec, command: 'set -eu; printf ordinary > work/ordinary.txt; cat work/ordinary.txt; cat /workspace/.tower/skills/image-gen/scripts/generate_image.py; test ! -e /workspace/.tower/skills/broken/SKILL.md' },
      signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
    });
    expect(isolated.execResult.exit_code).toBe(0);
    expect(isolated.execResult.stdout).toContain('ordinary');
    expect(isolated.execResult.stdout).toContain('print("mounted")');
    expect(isolated.execResult.stderr).toContain('broken (invalid_storage_mode)');
    await expect(fs.readFile(path.join(worker.root, 'work/ordinary.txt'), 'utf8')).resolves.toBe('ordinary');
    for (const invalidManifest of [
      JSON.stringify({ ...mixedManifest, skills: [{ name: 'broken', storageMode: 'bind-ro', bundleDigest: 'sha256:invalid' }] }),
      '{invalid json',
    ]) {
      await fs.writeFile(manifestPath, invalidManifest);
      const ordinaryOnly = await worker.transport.execute({
        spec: { ...baseSpec, command: 'set -eu; cat work/ordinary.txt; test ! -e /workspace/.tower/skills/broken/SKILL.md; test ! -e /workspace/.tower/skills/image-gen/SKILL.md' },
        signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
      });
      expect(ordinaryOnly.execResult.exit_code).toBe(0);
      expect(ordinaryOnly.execResult.stdout).toContain('ordinary');
      expect(ordinaryOnly.execResult.stderr).toContain('WORKER_MANAGED_SKILLS_SKIPPED');
      expect(ordinaryOnly.execResult.runtime_context).toMatchObject({ workstation: { filesystem_view: 'sandbox' } });
    }
    await fs.writeFile(manifestPath, JSON.stringify(mixedManifest));
    // Exercise the real sandbox, not just generated arguments: SSH never connects with -G.
    const identity = await worker.transport.execute({
      spec: { ...baseSpec, command: 'set -eu; test "$(id -u)" = ' + process.getuid!() + '; test "$(id -g)" = ' + process.getgid!() + '; id -un >/dev/null; id -gn >/dev/null; getent passwd "$(id -u)" >/dev/null; getent group "$(id -g)" >/dev/null; test "$(wc -l < /etc/passwd)" = 1; test "$(wc -l < /etc/group)" = 1; test -d "$HOME"; test -w "$HOME"; ssh -G -F /dev/null example.invalid >/dev/null 2>&1; printf identity-ssh-ok; printf worker-roundtrip > work/identity.txt' },
      signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
    });
    expect(identity.execResult).toMatchObject({ exit_code: 0, stdout: 'identity-ssh-ok' });
    await expect(fs.readFile(path.join(worker.root, 'work/identity.txt'), 'utf8')).resolves.toBe('worker-roundtrip');
    const homeMarker = `.tower-worker-home-${process.pid}-${Date.now()}`;
    const result = await worker.transport.execute({
      spec: { ...baseSpec, command: `test -d "$HOME"; test -w "$HOME"; printf persistent > "$HOME/${homeMarker}"; cat /workspace/.tower/skills/image-gen/scripts/generate_image.py; test ! -e /workspace/.tower/skills/other-skill; printf blocked > /workspace/.tower/skills/image-gen/scripts/generate_image.py` },
      signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
    });
    expect(result.execResult.exit_code).not.toBe(0);
    expect(result.execResult.stdout).toContain('print("mounted")');
    await expect(fs.readFile(path.join(process.env.HOME!, homeMarker), 'utf8')).resolves.toBe('persistent');
    await fs.rm(path.join(process.env.HOME!, homeMarker), { force: true });
    await expect(fs.readFile(path.join(allowed, 'scripts', 'generate_image.py'), 'utf8')).resolves.toBe('print("mounted")\n');
  });

  it('cleans materialized credentials when command launch fails before spawn', async () => {
    const { root, transport } = await fixture(undefined, undefined, undefined, 'project-sandbox-v1');
    const payload = Buffer.from(JSON.stringify({ envName: 'CONFIG_PATH', fileName: 'config.json', mode: '0600', credentialType: 'json', value: 'launch-failure-sentinel' })).toString('base64');
    await expect(transport.execute({
      spec: { ...baseSpec, command: 'true', environmentKeys: ['TOWER_REMOTE_FILE_CREDENTIAL_0', 'HOME'] },
      credentials: { TOWER_REMOTE_FILE_CREDENTIAL_0: payload, HOME: '/invalid:identity' },
      signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
    })).rejects.toThrow('WORKER_SANDBOX_IDENTITY_INVALID');
    await expect(fs.access(path.join(root, '.tower-run-credentials'))).rejects.toThrow();
  });

  it('rejects a Credential key mismatch before execution', async () => {
    const { transport } = await fixture();
    await expect(transport.execute({
      spec: { ...baseSpec, environmentKeys: ['API_TOKEN'] }, credentials: { OTHER_TOKEN: 'hidden' },
      signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
    })).rejects.toThrow('REMOTE_WORKER_HTTP_400');
  });


  it('maps a registered logical projection to its native host cwd', async () => {
    const projected = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-native-projection-'));
    roots.push(projected);
    await fs.mkdir(path.join(projected, 'packages'), { recursive: true });
    await fs.writeFile(path.join(projected, 'packages', 'marker.txt'), 'operator-source\n');
    const { transport } = await fixture({ '/workspace/tower': projected });
    const result = await transport.execute({
      spec: { ...baseSpec, cwd: '/workspace/tower/packages', command: 'pwd; cat marker.txt' },
      signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
    });
    expect(result.execResult.stdout).toBe(`${path.join(projected, 'packages')}\noperator-source\n`);
    expect(result.execResult.runtime_context.cwd).toBe('/workspace/tower/packages');
  });

  it('injects commit attribution only when the dedicated operator config declares it', async () => {
    const command = "printf '%s|%s|%s|%s' \"${GIT_AUTHOR_NAME-missing}\" \"${GIT_AUTHOR_EMAIL-missing}\" \"${GIT_COMMITTER_NAME-missing}\" \"${GIT_COMMITTER_EMAIL-missing}\"";
    const plain = await fixture();
    const plainResult = await plain.transport.execute({
      spec: { ...baseSpec, command }, signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
    });
    expect(plainResult.execResult.stdout).toBe('missing|missing|missing|missing');

    const operator = await fixture(undefined, { name: 'Tower Operator', email: 'operator@example.com' });
    const operatorResult = await operator.transport.execute({
      spec: { ...baseSpec, command }, signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
    });
    expect(operatorResult.execResult.stdout).toBe('Tower Operator|operator@example.com|Tower Operator|operator@example.com');
  });

  it('preserves the Worker rejection code and safe reason on HTTP 400', async () => {
    const { transport } = await fixture();
    await expect(transport.execute({
      spec: { ...baseSpec, cwd: '/home/tower/tower' },
      signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
    })).rejects.toThrow('REMOTE_WORKER_HTTP_400: INVALID_RUN: cwd must use a registered /workspace path');
  });

  it('starts in the real Project directory while reporting the logical Project cwd', async () => {
    const { root, transport } = await fixture();
    const result = await transport.execute({
      spec: { ...baseSpec, cwd: '/workspace/work', command: 'pwd' },
      signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
    });
    expect(result.execResult.stdout.trim()).toBe(path.join(root, 'work'));
    expect(result.execResult.runtime_context.cwd).toBe('/workspace/work');
  });

  it('can use native host identity, tools, and paths outside the default Project scope', async () => {
    const { transport } = await fixture();
    const result = await transport.execute({
      spec: {
        ...baseSpec,
        command: "test -r /etc/passwd && test -r /etc/resolv.conf && command -v sh >/dev/null && cd /tmp && printf native-host",
      },
      signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {},
    });
    expect(result.execResult).toMatchObject({ exit_code: 0, stdout: 'native-host' });
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

  it.each(['legacy-skill-dependent', 'project-sandbox-v1'] as const)('aborts the process group without a completion artifact in %s', async isolationProfile => {
    const { root, transport } = await fixture(undefined, undefined, undefined, isolationProfile);
    const controller = new AbortController();
    const stdout: string[] = [];
    const running = transport.execute({
      spec: { ...baseSpec, command: "printf 'started\\n'; sleep 5; printf done > work/should-not-exist.txt" },
      signal: controller.signal,
      onStdout: chunk => stdout.push(chunk), onStderr: () => {},
    });
    const deadline = Date.now() + 3000;
    while (!stdout.join('').includes('started') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    if (!stdout.join('').includes('started')) { controller.abort(); await running.catch(() => {}); throw new Error('worker start deadline exceeded'); }
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise(resolve => setTimeout(resolve, 700));
    await expect(fs.access(path.join(root, 'work', 'should-not-exist.txt'))).rejects.toThrow();
  });
});

it('routes Worker HTTP to installed executor and never uses native fallback', async () => {
 let calls=0;
 const f=await fixture(undefined,undefined,undefined,undefined,root=>({
  mapping:{projectId:'project-a',projectRoot:root,home:root,controllerUid:62002,launcherUid:62003,commandUid:62001,commandGid:62001},
  execute:async input=>{calls++; expect(input.credentials).toEqual({});return {exitCode:0,stdout:'executor-only',stderr:'',cleanupComplete:true,processGroupExited:true};},
 }));
 const result=await f.transport.execute({spec:{...baseSpec,command:'touch SHOULD_NOT_RUN'},signal:new AbortController().signal,onStdout:()=>{},onStderr:()=>{}});
 expect(result.execResult.stdout).toBe('executor-only'); expect(calls).toBe(1);
 await expect(fs.stat(path.join(f.root,'SHOULD_NOT_RUN'))).rejects.toMatchObject({code:'ENOENT'});
 const ready=await (await fetch(f.baseUrl+'/ready')).json();expect(ready.capabilities).toEqual(['shell-internal-executor']);
});
it('fails closed without installed executor capability', async()=>{
 const f=await fixture(undefined,undefined,undefined,undefined,()=>undefined);
 expect((await fetch(f.baseUrl+'/ready')).status).toBe(503);
 await expect(f.transport.execute({spec:baseSpec,signal:new AbortController().signal,onStdout:()=>{},onStderr:()=>{}})).rejects.toThrow('CAPABILITY_UNAVAILABLE');
});
it('rejects same-UID installed executor mapping before execute',async()=>{
 const f=await fixture(undefined,undefined,undefined,undefined,root=>({mapping:{projectId:'project-a',projectRoot:root,home:root,controllerUid:1,launcherUid:1,commandUid:2,commandGid:2},execute:async()=>{throw new Error('must-not-run');}}));
 await expect(f.transport.execute({spec:baseSpec,signal:new AbortController().signal,onStdout:()=>{},onStderr:()=>{}})).rejects.toThrow('IDENTITY_INVALID');
});

it('connects Worker HTTP through signed Unix IPC to dispatcher and real child', async()=>{
 const {generateKeyPairSync}=await import('node:crypto');const {execFile}=await import('node:child_process');
 const {createSignedWorkstationExecutor}=await import('./workstation-executor-capability.js');
 const {createWorkstationLaunchServer}=await import('./workstation-launch-transport.js');
 const {createWorkstationLaunchDispatcher}=await import('./workstation-launch-dispatch.js');
 const {createWorkstationLaunchVerifier}=await import('./workstation-launch-authorization.js');
 const keys=generateKeyPairSync('ed25519');let cleaned=false;
 const ipcRoot=await fs.mkdtemp(path.join(os.tmpdir(),'tower-http-ipc-'));roots.push(ipcRoot);const socket=path.join(ipcRoot,'s');
 let dispatch!:ReturnType<typeof createWorkstationLaunchDispatcher>;
 const ipc=createWorkstationLaunchServer((r,s)=>dispatch(r,s));await new Promise<void>(r=>ipc.server.listen(socket,r));
 try{
 const f=await fixture(undefined,undefined,undefined,undefined,root=>{
 const uid=process.getuid!(),gid=process.getgid!();
 dispatch=createWorkstationLaunchDispatcher({policy:{projectId:'project-a',uid,gid,home:root,projectRoot:root},controllerUid:uid+1,identity:()=>({uid,gid,groups:[gid]}),
 verify:createWorkstationLaunchVerifier({publicKey:keys.publicKey,projectId:'project-a',instanceId:'http-ipc'}),
 prepare:async()=>({env:{},cleanup:async()=>{cleaned=true;}}),
 run:input=>new Promise((resolve,reject)=>execFile('/bin/sh',['-c',input.command],{cwd:input.cwd,env:{HOME:input.home},signal:input.signal,timeout:1000},(err,stdout,stderr)=>err?reject(err):resolve({exitCode:0,stdout,stderr,cleanupComplete:true,processGroupExited:true}))),
 });
 return createSignedWorkstationExecutor({mapping:{projectId:'project-a',projectRoot:root,home:root,controllerUid:62002,launcherUid:62003,commandUid:62001,commandGid:62001},socketPath:socket,instanceId:'http-ipc',privateKey:keys.privateKey});
 });
 const result=await f.transport.execute({spec:{...baseSpec,command:'printf linked > work/linked; printf connected'},signal:new AbortController().signal,onStdout:()=>{},onStderr:()=>{}});
 expect(result.execResult.stdout).toBe('connected');expect(cleaned).toBe(true);
 expect(await fs.readFile(path.join(f.root,'work/linked'),'utf8')).toBe('linked');
 expect(result.execResult.runtime_context.credential_env).toBeUndefined();expect(result.execResult.runtime_context.workstation).toBeUndefined();
 }finally{await ipc.close();}
});

it.each([
 ['cleanup', {exitCode:0,stdout:'',stderr:'',cleanupComplete:'true',processGroupExited:true}, 'EXECUTOR_CLEANUP_INCOMPLETE'],
 ['output', {exitCode:0,stdout:{secret:'sentinel'},stderr:'',cleanupComplete:true,processGroupExited:true}, 'EXECUTOR_RESULT_INVALID'],
] as const)('rejects executor %s failure over HTTP',async(_name,value,error)=>{
 const f=await fixture(undefined,undefined,undefined,undefined,root=>({mapping:{projectId:'project-a',projectRoot:root,home:root,controllerUid:62002,launcherUid:62003,commandUid:62001,commandGid:62001},execute:async()=>value as any}));
 await expect(f.transport.execute({spec:baseSpec,signal:new AbortController().signal,onStdout:()=>{},onStderr:()=>{}})).rejects.toThrow(error);
});
it('bounds an executor ignoring abort without claiming successful cleanup',async()=>{
 let aborted=false;
 const f=await fixture(undefined,undefined,undefined,undefined,root=>({mapping:{projectId:'project-a',projectRoot:root,home:root,controllerUid:62002,launcherUid:62003,commandUid:62001,commandGid:62001},execute:async input=>{input.signal.addEventListener('abort',()=>aborted=true);return new Promise(()=>{});}}));
 await expect(f.transport.execute({spec:{...baseSpec,timeoutSec:1},signal:new AbortController().signal,onStdout:()=>{},onStderr:()=>{}})).rejects.toThrow('TIMEOUT_UNVERIFIED');expect(aborted).toBe(true);
});
it('marks invalid installed mapping unready and rejects unsupported requests',async()=>{
 const f=await fixture(undefined,undefined,undefined,undefined,root=>({mapping:{projectId:'project-a',projectRoot:root,home:root,controllerUid:1,launcherUid:1,commandUid:2,commandGid:2},execute:async()=>{throw new Error('not called');}}));
 expect((await fetch(f.baseUrl+'/ready')).status).toBe(503);
 const good=await fixture(undefined,undefined,undefined,undefined,root=>({mapping:{projectId:'project-a',projectRoot:root,home:root,controllerUid:1,launcherUid:2,commandUid:3,commandGid:3},execute:async()=>{throw new Error('not called');}}));
 for(const patch of [{cwd:'/workspace/work'},{lifecycle:'service-control' as const}])await expect(good.transport.execute({spec:{...baseSpec,...patch},signal:new AbortController().signal,onStdout:()=>{},onStderr:()=>{}})).rejects.toThrow('REQUEST_UNSUPPORTED');
});
it('propagates HTTP disconnect cancellation to executor cleanup',async()=>{
 let started!:()=>void;const ready=new Promise<void>(r=>started=r);let cleaned=false;
 const f=await fixture(undefined,undefined,undefined,undefined,root=>({mapping:{projectId:'project-a',projectRoot:root,home:root,controllerUid:1,launcherUid:2,commandUid:3,commandGid:3},execute:async input=>{
  started();await new Promise<void>(r=>input.signal.addEventListener('abort',()=>r(),{once:true}));cleaned=true;throw new Error('cancelled');
 }}));
 const abort=new AbortController();const result=f.transport.execute({spec:baseSpec,signal:abort.signal,onStdout:()=>{},onStderr:()=>{}}).catch(()=>undefined);
 await ready;abort.abort();await result;
 for(let i=0;i<100&&!cleaned;i++)await new Promise(r=>setTimeout(r,10));expect(cleaned).toBe(true);
});

describe('managed download Worker policy', () => {
 it('accepts a 24h managed download and returns structured blocked evidence, rejects ordinary 24h commands', async () => {
  const {buildDownloadCommand}=await import('../execution/downloads/download-contract.js');
  const f=await fixture();
  const command=buildDownloadCommand({url:'https://127.0.0.1/data',destination:'work/data'});
  const result=await f.transport.execute({spec:{...baseSpec,command,timeoutSec:86400},signal:new AbortController().signal,onStdout:()=>{},onStderr:()=>{}});
  expect(result.execResult.exit_code).toBe(1);
  expect(result.execResult.stdout).toContain('UNSAFE_URL');
  await expect(f.transport.execute({spec:{...baseSpec,command:'true',timeoutSec:86400},signal:new AbortController().signal,onStdout:()=>{},onStderr:()=>{}})).rejects.toThrow();
 });
});
