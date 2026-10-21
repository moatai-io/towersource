import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tokenMock = vi.hoisted(() => vi.fn(async () => 'synthetic-worker-token'));
vi.mock('../execution/worker/worker-transport-credentials.js', () => ({
  resolveWorkbenchWorkerTransportToken: tokenMock,
}));
vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn() }));
vi.mock('../project-environment/project-workspace-authority.js', () => ({ resolveProjectWorkspaceTarget: vi.fn() }));
vi.mock('../project-environment/project-environment-deployment.js', () => ({ resolveProjectEnvironmentDeploymentId: vi.fn() }));
vi.mock('../execution/worker/worker-repository.js', () => ({ getPersistedWorkbenchWorker: vi.fn() }));

const { statWorkerProjectFile, readWorkerProjectFileProbe, openWorkerProjectFileStream } = await import('./workbench-project-file-authority.js');

const authority = {
  projectId: 'project-a',
  projectRoot: '/workspace/projects/a',
  relativePath: 'uploads/video.mp4',
  workerId: 'worker-a',
  workerBaseUrl: 'http://worker.example.test',
};

describe('openWorkerProjectFileStream', () => {
  beforeEach(() => tokenMock.mockClear());
  afterEach(() => vi.unstubAllGlobals());

  it('queries HEAD metadata without downloading a body', async () => {
    const request = vi.fn(async (..._args: any[]) => new Response(null, { status: 200, headers: { 'content-length': '3000000', 'x-tower-file-version': 'v1' } }));
    vi.stubGlobal('fetch', request);
    expect(await statWorkerProjectFile({ authority, actorUserId: 7 })).toEqual({ sizeBytes: 3000000, version: 'v1' });
    expect(request.mock.calls[0][1]).toMatchObject({ method: 'HEAD' });
  });

  it('reads only the returned Range prefix regardless of total file size', async () => {
    const bytes = Buffer.alloc(65536, 65);
    const request = vi.fn(async (..._args: any[]) => new Response(bytes, { status: 206, headers: { 'content-range': 'bytes 0-65535/3000000' } }));
    vi.stubGlobal('fetch', request);
    expect(await readWorkerProjectFileProbe({ authority, actorUserId: 7, maxBytes: 65536 })).toEqual(bytes);
    expect(request.mock.calls[0][1]).toMatchObject({ headers: { range: 'bytes=0-65535' } });
  });

  it('rejects Range ignored by Worker, invalid ranges and truncated response bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('full file', { status: 200 })));
    await expect(readWorkerProjectFileProbe({ authority, actorUserId: 7, maxBytes: 64 })).rejects.toThrow('WORKER_FILE_PROBE_RANGE_INVALID');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('abc', { status: 206, headers: { 'content-range': 'bytes 0-63/1000' } })));
    await expect(readWorkerProjectFileProbe({ authority, actorUserId: 7, maxBytes: 64 })).rejects.toThrow('WORKER_FILE_PROBE_TRUNCATED');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('abcdef', { status: 206, headers: { 'content-range': 'bytes 0-3/4' } })));
    await expect(readWorkerProjectFileProbe({ authority, actorUserId: 7, maxBytes: 64 })).rejects.toThrow('WORKER_FILE_PROBE_SIZE_LIMIT');
  });

  it('handles a short file or empty file without a full-download fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('abc', { status: 206, headers: { 'content-range': 'bytes 0-2/3' } })));
    expect((await readWorkerProjectFileProbe({ authority, actorUserId: 7, maxBytes: 64 })).toString()).toBe('abc');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 416, headers: { 'content-range': 'bytes */0' } })));
    expect(await readWorkerProjectFileProbe({ authority, actorUserId: 7, maxBytes: 64 })).toEqual(Buffer.alloc(0));
  });

  it('fails closed on missing metadata and invalid probe budgets', async () => {
    const request = vi.fn(async (..._args: any[]) => new Response(null, { status: 200 })); vi.stubGlobal('fetch', request);
    await expect(statWorkerProjectFile({ authority, actorUserId: 7 })).rejects.toThrow('WORKER_FILE_METADATA_UNSUPPORTED');
    request.mockClear();
    await expect(readWorkerProjectFileProbe({ authority, actorUserId: 7, maxBytes: 0 })).rejects.toThrow('WORKER_FILE_PROBE_LIMIT_INVALID');
    expect(request).not.toHaveBeenCalled();
  });

  it('forwards only authorization and one optional Range header without buffering', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('23')); controller.close(); } });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 206, headers: { 'content-range': 'bytes 2-3/10' } }));
    const response = await openWorkerProjectFileStream({ authority, actorUserId: 7, range: 'bytes=2-3', fetchImpl: fetchImpl as any });
    expect(response.status).toBe(206);
    const [requestedUrl, requestedInit] = fetchImpl.mock.calls[0];
    expect(String(requestedUrl)).toBe('http://worker.example.test/v1/files/project-a/content?path=uploads%2Fvideo.mp4');
    expect(requestedInit).toMatchObject({
      method: 'GET',
      headers: { authorization: 'Bearer synthetic-worker-token', range: 'bytes=2-3' },
    });
    expect(response.body).toBe(body);
  });

  it('returns 416 to the caller but rejects unexpected Worker failures', async () => {
    const rangeFailure = await openWorkerProjectFileStream({
      authority,
      actorUserId: 7,
      fetchImpl: vi.fn(async () => new Response(null, { status: 416 })) as any,
    });
    expect(rangeFailure.status).toBe(416);
    await expect(openWorkerProjectFileStream({
      authority,
      actorUserId: 7,
      fetchImpl: vi.fn(async () => new Response('bad gateway', { status: 502 })) as any,
    })).rejects.toThrow('WORKER_FILE_STREAM_FAILED: HTTP 502');
  });

  it('fails closed when no Worker transport token is available', async () => {
    tokenMock.mockResolvedValueOnce(null);
    const fetchImpl = vi.fn();
    await expect(openWorkerProjectFileStream({ authority, actorUserId: 7, fetchImpl: fetchImpl as any }))
      .rejects.toThrow('WORKER_FILE_AUTHORITY_TOKEN_MISSING');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
