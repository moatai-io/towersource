import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../db/pg-repo.js', () => ({ queryOne: vi.fn(async () => ({ visibility: 'project' })) }));
const mocks = vi.hoisted(() => ({ resolve:vi.fn(), attachment:vi.fn(), reference:vi.fn() }));
vi.mock('../services/credential-vault/credential-vault-service.js', () => ({ resolveProjectApiKeySecretValue:mocks.resolve }));
// Exercise the real source gateway and byte-read contract; only session authority is synthetic.
vi.mock('../services/session-attachments/session-attachment-store.js', () => ({ resolveAuthorizedSessionAttachment:mocks.attachment }));
vi.mock('../services/execution/worker/worker-transport-credentials.js', () => ({ resolveWorkbenchWorkerTransportToken:async () => 'synthetic-token' }));
vi.mock('../services/project-environment/project-workspace-files.js', async () => {
  const { writeWorkerProjectFile } = await import('../services/runtime-box/workbench-project-file-authority.js');
  return { resolveProjectWorkspaceFile:mocks.reference,
    writeProjectWorkspaceText:async ({reference,actorUserId,content,exclusive}:any) => writeWorkerProjectFile({authority:reference.workerAuthority,actorUserId,content,exclusive}) };
});
const { createDocumentParseTool } = await import('./pi-document-parse-tool.js');
const { createRemoteWorkbenchWorkerServer } = await import('../services/execution/worker/worker-server.js');
let root:string|undefined; let server:http.Server|undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (server) { server.closeIdleConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server=undefined; }
  if (root) { await fs.rm(root,{recursive:true,force:true});root=undefined; }
});

it('stores large converted Markdown on real Worker file HTTP rather than execution JSON', async () => {
  root=await fs.mkdtemp(path.join(os.tmpdir(),'parse-worker-output-'));
  const source=path.join(root,'source.docx'); await fs.writeFile(source,Buffer.from('PK synthetic DOCX'));
  server=createRemoteWorkbenchWorkerServer({workerId:'w',token:'synthetic-token',projects:{p:root}});
  const requests:string[]=[];server.on('request',request => requests.push(request.url||''));
  await new Promise<void>(resolve => server!.listen(0,'127.0.0.1',resolve));
  const address=server.address();if (!address || typeof address==='string') throw new Error('listen');
  const uri='session://attachments/11111111-1111-4111-8111-111111111111';
  mocks.attachment.mockResolvedValue({path:source,document:{name:'source.docx'}});
  mocks.resolve.mockResolvedValue({status:'resolved',value:'synthetic-gateway-token'});
  mocks.reference.mockImplementation(async ({relativePath}:any) => ({workerAuthority:{projectId:'p',projectRoot:root,relativePath,workerId:'w',workerBaseUrl:`http://127.0.0.1:${address.port}`}}));
  const markdown='# Report\n'+'한글 변환 결과\n'.repeat(18000);
  const realFetch=globalThis.fetch;
  vi.stubGlobal('fetch',vi.fn(async (url:any,options:any) => new URL(String(url)).hostname !== '127.0.0.1'
    ? new Response(JSON.stringify({markdown}),{status:200,headers:{'content-type':'application/json'}})
    : realFetch(url,options)));
  const tool=createDocumentParseTool({cwd:root,projectRoot:root,projectId:'p',userId:7,sessionId:'s1'});
  const result:any=await tool.execute!('parse',{path:uri,output_path:'work/large-report.md'});
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(await fs.readFile(path.join(root,'work/large-report.md'),'utf8')).toBe(markdown);
  expect(Buffer.byteLength(markdown)).toBeGreaterThan(64000);
  expect(mocks.attachment).toHaveBeenCalledTimes(2);
  expect(requests.every(url => url.startsWith('/v1/files/'))).toBe(true);
  expect(requests.some(url => url.includes('text-mode=exclusive'))).toBe(true);
  const conflict:any=await tool.execute!('parse-again',{path:uri,output_path:'work/large-report.md'});
  expect(conflict.isError).toBe(true);
  expect(await fs.readFile(path.join(root,'work/large-report.md'),'utf8')).toBe(markdown);
});
