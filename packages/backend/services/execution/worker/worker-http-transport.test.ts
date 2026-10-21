import { describe, expect, it, vi } from 'vitest';
import { createRemoteWorkbenchHttpTransport } from './worker-http-transport.js';

const spec = {
  jobId: 1,
  projectId: 'project-a',
  actorUserId: 7,
  sessionId: 'session-a',
  command: 'pwd',
  workbenchRevision: null,
  environmentKeys: [],
};

const execute = (fetchImpl: typeof fetch, signal = new AbortController().signal, readinessGraceMs = 0) => createRemoteWorkbenchHttpTransport({
  workerId: 'worker-a',
  baseUrl: 'http://127.0.0.1:43125',
  token: 'synthetic-token',
  readinessGraceMs,
  readinessPollMs: 25,
  fetchImpl,
}).execute({ spec, signal, onStdout: () => {}, onStderr: () => {} });

describe('Remote Workbench HTTP transport error classification', () => {
  it('never dispatches a pre-aborted request even with zero readiness grace', async () => {
    const controller = new AbortController(); controller.abort(); const request = vi.fn();
    await expect(execute(request as typeof fetch, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).not.toHaveBeenCalled();
  });
  it('preserves cancellation during HTTP rejection body reads', async () => {
    const controller = new AbortController(); const body = new ReadableStream({ start(stream) {
      controller.abort(); stream.error(new DOMException('cancelled', 'AbortError'));
    } });
    const request = vi.fn().mockResolvedValue(new Response(body, { status: 503 }));
    await expect(execute(request as typeof fetch, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('classifies connection failure as Worker unreachable instead of missing binding', async () => {
    const failure = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }) });
    await expect(execute(vi.fn().mockRejectedValue(failure) as typeof fetch))
      .rejects.toThrow('WORKER_UNREACHABLE: worker-a; dispatch failed (ECONNREFUSED)');
  });

  it('preserves explicit cancellation instead of misclassifying the Worker as unreachable', async () => {
    const aborted = new DOMException('This operation was aborted', 'AbortError');
    await expect(execute(vi.fn().mockRejectedValue(aborted) as typeof fetch))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('waits through restart readiness without sending the run POST more than once', async () => {
    const result = { execResult: { exit_code: 0, stdout: '', stderr: '', duration_ms: 1, timed_out: false, oom_killed: false, runtime_context: {} }, artifacts: [], cancellation: { requested: false, processGroupExited: true } };
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, workerId: 'worker-a' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, workerId: 'worker-a' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(`${JSON.stringify({ type: 'result', result })}\n`, { status: 200 }));
    await expect(execute(fetchImpl as typeof fetch, new AbortController().signal, 250)).resolves.toEqual(result);
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/ready'))).toHaveLength(3);
  });

  it('does not retry the run POST when dispatch outcome is uncertain', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, workerId: 'worker-a' }), { status: 200 }))
      .mockRejectedValueOnce(Object.assign(new Error('socket closed'), { cause: { code: 'ECONNRESET' } }));
    await expect(execute(fetchImpl as typeof fetch, new AbortController().signal, 100))
      .rejects.toThrow('WORKER_UNREACHABLE: worker-a; dispatch failed (ECONNRESET)');
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('reports a headers timeout as an uncertain POST outcome, not proof of Worker death', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }));
    await expect(execute(fetchImpl as typeof fetch)).rejects.toThrow(/dispatch failed \(UND_ERR_HEADERS_TIMEOUT\); phase=waiting for response headers; elapsedMs=\d+; POST outcome unknown — inspect effects before retry/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('measures only the POST wait and reports elapsed time without inferring command duration', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 15));
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } });
    });
    const error = await execute(fetchImpl as typeof fetch).catch((failure: Error) => failure);
    expect(error.message).toMatch(/phase=waiting for response headers; elapsedMs=\d+/);
    const elapsed = Number(error.message.match(/elapsedMs=(\d+)/)?.[1]);
    expect(elapsed).toBeGreaterThanOrEqual(10);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports response stream interruption separately from dispatch failure', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"type":"stdout","chunk":"started"}\n'));
        controller.error(Object.assign(new Error('stream lost'), { code: 'ECONNRESET' }));
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    await expect(execute(fetchImpl as typeof fetch)).rejects.toThrow('WORKER_RESPONSE_INTERRUPTED: worker-a; response body interrupted (transport error); response headers received, completion unknown');
  });

  it('keeps an HTTP Worker rejection distinct from transport unreachability', async () => {
    const response = new Response('{"type":"error","code":"WORKER_MAINTENANCE","message":"draining"}\n', { status: 503 });
    await expect(execute(vi.fn().mockResolvedValue(response) as typeof fetch))
      .rejects.toThrow('REMOTE_WORKER_HTTP_503: WORKER_MAINTENANCE: draining');
  });
});
