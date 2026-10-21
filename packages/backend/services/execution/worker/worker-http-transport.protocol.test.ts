import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createRemoteWorkbenchHttpTransport } from './worker-http-transport.js';
import { verifyWorkbenchProjectExecutionGrant } from '../../runtime-box/workbench-project-execution-grant.js';
const spec = { jobId: 1, projectId: 'project-a', actorUserId: 7, sessionId: 'session-a', command: 'true', workbenchRevision: null, environmentKeys: [] };
const result = { execResult: { exit_code: 0, stdout: 'ok', stderr: '', duration_ms: 1, timed_out: false, oom_killed: false, runtime_context: { runtime: 'workbench-worker' } }, artifacts: [] };
const terminal = JSON.stringify({ type: 'result', result });
function execute(fetchImpl: typeof fetch, onStdout: (value: string) => void = () => {}) {
  return createRemoteWorkbenchHttpTransport({ workerId: 'synthetic-worker', baseUrl: 'http://127.0.0.1:1', token: 'synthetic-token', fetchImpl })
    .execute({ spec, signal: new AbortController().signal, onStdout, onStderr: () => {} });
}
let server: http.Server | undefined;
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } });

describe('Worker outcome classification and protocol cleanup', () => {
  it.each(['{broken', 'null', JSON.stringify({ type: 'wat' }), JSON.stringify({ type: 'stdout', chunk: 3 }),
    JSON.stringify({ type: 'result', result: {} }), JSON.stringify({ type: 'error', code: 9, message: 'invalid' }), terminal + '\n' + terminal])
    ('rejects malformed/duplicate protocol without exposing raw data or replaying POST: %s', async text => {
      const fetchImpl = vi.fn().mockResolvedValue(new Response(text + '\n'));
      await expect(execute(fetchImpl)).rejects.toThrow('REMOTE_WORKER_PROTOCOL_ERROR');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  it('does not misclassify local output callback failure as remote transport', async () => {
    const failure = new Error('local consumer failed'); const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"type":"stdout","chunk":"x"}\n')); }, cancel });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body));
    await expect(execute(fetchImpl, () => { throw failure; })).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledTimes(1); expect(body.locked).toBe(false);
  });
  it('preserves explicit Worker errors and cancels the rest of the stream', async () => {
    const cancel = vi.fn(); const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"type":"error","code":"PROJECT_EXECUTION_DENIED","message":"denied"}\n'));
    }, cancel });
    await expect(execute(vi.fn().mockResolvedValue(new Response(body)))).rejects.toThrow('PROJECT_EXECUTION_DENIED: denied');
    expect(cancel).toHaveBeenCalledTimes(1); expect(body.locked).toBe(false);
  });
  it('accepts a fragmented UTF-8 stream and final line without newline', async () => {
    const bytes = new TextEncoder().encode('{"type":"stdout","chunk":"한글"}\n' + terminal);
    const chunks: string[] = [];
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
    await expect(execute(vi.fn().mockResolvedValue(new Response(body)), value => chunks.push(value))).resolves.toEqual(result);
    expect(chunks).toEqual(['한글']); expect(body.locked).toBe(false);
  });
  it.each(['headers-lost', 'body-lost', 'clean-eof-without-result', 'cancel'])
    ('uses real localhost HTTP with exactly one POST after %s', async mode => {
      let posts = 0; const controller = new AbortController(); let posted!: () => void;
      const received = new Promise<void>(resolve => { posted = resolve; });
      server = http.createServer((req, res) => {
        if (req.method !== 'POST') { res.end('unexpected'); return; }
        posts++; req.resume(); posted();
        if (mode === 'headers-lost') { req.socket.destroy(); return; }
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write('{"type":"stdout","chunk":"partial"}\n');
        if (mode === 'clean-eof-without-result') res.end();
        else if (mode === 'body-lost') setTimeout(() => res.destroy(), 20);
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const address = server.address() as import('node:net').AddressInfo;
      const transport = createRemoteWorkbenchHttpTransport({ workerId: 'synthetic-worker', baseUrl: `http://127.0.0.1:${address.port}`, token: 'synthetic-token' });
      const request = transport.execute({ spec, signal: controller.signal, onStdout: () => {}, onStderr: () => {} });
      const error = request.catch(value => value);
      await received; if (mode === 'cancel') controller.abort();
      const failure = await error;
      if (mode === 'headers-lost') expect(failure.message).toContain('WORKER_UNREACHABLE');
      if (mode === 'body-lost') expect(failure.message).toContain('WORKER_RESPONSE_INTERRUPTED');
      if (mode === 'clean-eof-without-result') expect(failure.message).toContain('REMOTE_WORKER_PROTOCOL_ERROR');
      if (mode === 'cancel') expect(failure.name).toBe('AbortError');
      expect(posts).toBe(1);
    });
});

const projectRoot = '/srv/workspace/projects/project-a';
const teamScope = { teamId: 'team-a', mounts: [{ workspaceId: 'a-files', ownerProjectId: 'project-a',
  source: projectRoot, target: '/workspace', readOnly: false }] };
const runInput = { spec, signal: new AbortController().signal, onStdout: () => {}, onStderr: () => {} };

describe('trusted team scope transport (no Worker activation)', () => {
  it('passes only trusted option scope in a signed grant over localhost HTTP', async () => {
    let received: any; let posts = 0;
    server = http.createServer(async (req, res) => {
      posts++;
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.end(terminal + '\n');
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as import('node:net').AddressInfo;
    const transport = createRemoteWorkbenchHttpTransport({ workerId: 'synthetic-worker',
      baseUrl: `http://127.0.0.1:${address.port}`, token: 'synthetic-token', projectRoot, teamScope });
    await expect(transport.execute(runInput)).resolves.toEqual(result);
    expect(posts).toBe(1);
    const verified = verifyWorkbenchProjectExecutionGrant({ grant: received.executionGrant, secret: 'synthetic-token',
      workerId: 'synthetic-worker', spec: received.spec, allowTeamScope: true });
    expect(verified.teamScope).toEqual(teamScope);
    expect(received).not.toHaveProperty('teamScope');
    expect(received.spec).not.toHaveProperty('teamScope');
    // The existing Worker consumer does not opt in: receipt creation is not activation.
    expect(() => verifyWorkbenchProjectExecutionGrant({ grant: received.executionGrant, secret: 'synthetic-token',
      workerId: 'synthetic-worker', spec: received.spec })).toThrow('TEAM_EXECUTION_SCOPE_UNSUPPORTED');
  });
  it.each([undefined, ''])('rejects trusted scope without a signing Project root before any HTTP (%s)', async root => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(terminal));
    const transport = createRemoteWorkbenchHttpTransport({ workerId: 'synthetic-worker', baseUrl: 'http://127.0.0.1:1',
      token: 'synthetic-token', projectRoot: root, teamScope, readinessGraceMs: 1000, fetchImpl });
    await expect(transport.execute(runInput)).rejects.toThrow('TEAM_EXECUTION_SCOPE_PROJECT_ROOT_REQUIRED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('rejects malformed trusted scope before readiness/dispatch instead of silently dropping it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(terminal));
    const transport = createRemoteWorkbenchHttpTransport({ workerId: 'synthetic-worker', baseUrl: 'http://127.0.0.1:1',
      token: 'synthetic-token', projectRoot, teamScope: { ...teamScope, mounts: [] }, readinessGraceMs: 1000, fetchImpl });
    await expect(transport.execute(runInput)).rejects.toThrow('TEAM_EXECUTION_SCOPE_INVALID');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('does not promote unsigned spec scope to grant authority', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(terminal));
    const transport = createRemoteWorkbenchHttpTransport({ workerId: 'synthetic-worker', baseUrl: 'http://127.0.0.1:1',
      token: 'synthetic-token', projectRoot, fetchImpl });
    const unsignedSpec = { ...spec, teamScope, mounts: teamScope.mounts };
    await transport.execute({ ...runInput, spec: unsignedSpec });
    const received = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const verified = verifyWorkbenchProjectExecutionGrant({ grant: received.executionGrant, secret: 'synthetic-token',
      workerId: 'synthetic-worker', spec: received.spec });
    expect(verified).not.toHaveProperty('teamScope');
    expect(verified).not.toHaveProperty('teamScopeDigest');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('never replaces trusted option scope with conflicting unsigned spec fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(terminal));
    const transport = createRemoteWorkbenchHttpTransport({ workerId: 'synthetic-worker', baseUrl: 'http://127.0.0.1:1',
      token: 'synthetic-token', projectRoot, teamScope, fetchImpl });
    await transport.execute({ ...runInput, spec: { ...spec, teamScope: { teamId: 'untrusted', mounts: [] } } as any });
    const received = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(verifyWorkbenchProjectExecutionGrant({ grant: received.executionGrant, secret: 'synthetic-token',
      workerId: 'synthetic-worker', spec: received.spec, allowTeamScope: true }).teamScope).toEqual(teamScope);
  });
  it('preserves Worker unsupported errors with exactly one dispatch and no fallback', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ type: 'error',
      code: 'TEAM_EXECUTION_SCOPE_UNSUPPORTED', message: 'team consumer not enabled' }), { status: 403 }));
    const transport = createRemoteWorkbenchHttpTransport({ workerId: 'synthetic-worker', baseUrl: 'http://127.0.0.1:1',
      token: 'synthetic-token', projectRoot, teamScope, fetchImpl });
    await expect(transport.execute(runInput)).rejects.toThrow('TEAM_EXECUTION_SCOPE_UNSUPPORTED');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
