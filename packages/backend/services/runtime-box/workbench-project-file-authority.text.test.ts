import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../execution/worker/worker-transport-credentials.js', () => ({ resolveWorkbenchWorkerTransportToken: async () => 'synthetic-token' }));
const { writeWorkerProjectFile, compareAndSwapWorkerProjectFile } = await import('./workbench-project-file-authority.js');
const { createRemoteWorkbenchWorkerServer } = await import('../execution/worker/worker-server.js');
let server: http.Server | undefined;
let root: string | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (server) { server.closeIdleConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
  if (root) { await fs.rm(root, { recursive: true, force: true }); root = undefined; }
});

describe('Worker text authority transport', () => {
  it('uses raw file HTTP for large create/edit without any run request', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(),'authority-text-'));
    server = createRemoteWorkbenchWorkerServer({ workerId:'w', token:'synthetic-token', projects:{p:root} });
    const requests: string[] = [];
    server.on('request', req => requests.push(`${req.method} ${req.url}`));
    await new Promise<void>(resolve => server!.listen(0,'127.0.0.1',resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('listen');
    const authority = { projectId:'p', projectRoot:root, relativePath:'work/generated.md', workerId:'w', workerBaseUrl:`http://127.0.0.1:${address.port}` };
    const original = '# 보고서\n' + '본문 내용\n'.repeat(25000);
    await writeWorkerProjectFile({ authority, actorUserId:7, content:original, exclusive:true });
    expect(await fs.readFile(path.join(root,'work/generated.md'),'utf8')).toBe(original);
    await expect(writeWorkerProjectFile({ authority, actorUserId:7, content:'collision', exclusive:true })).rejects.toMatchObject({ code:'EEXIST' });
    const replacement = '# 수정\n' + 'new content\n'.repeat(25000);
    await compareAndSwapWorkerProjectFile({ authority, actorUserId:7, expectedContent:original, content:replacement });
    await expect(compareAndSwapWorkerProjectFile({ authority, actorUserId:7, expectedContent:original, content:'stale' })).rejects.toThrow('SCOPED_EDIT_STALE_SOURCE');
    expect(await fs.readFile(path.join(root,'work/generated.md'),'utf8')).toBe(replacement);
    expect(requests.every(request => request.includes('/v1/files/p/content?'))).toBe(true);
    expect(requests.some(request => request.startsWith('HEAD'))).toBe(true);
    expect(requests.some(request => request.includes('text-mode=cas'))).toBe(true);
  });

  it('does not PUT to an older Worker that would ignore text-mode', async () => {
    const request = vi.fn(async (..._args:any[]) => new Response(null,{status:200,headers:{'content-length':'123'}}));
    vi.stubGlobal('fetch',request);
    const authority = { projectId:'p', projectRoot:'/workspace/p', relativePath:'file.md', workerId:'w', workerBaseUrl:'http://worker.test' };
    await expect(writeWorkerProjectFile({authority,actorUserId:7,content:'large',exclusive:true})).rejects.toThrow('PROTOCOL_UNSUPPORTED');
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][1]).toMatchObject({method:'HEAD'});
  });
});
