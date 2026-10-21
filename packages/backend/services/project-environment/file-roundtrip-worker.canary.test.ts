import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createRemoteWorkbenchWorkerServer } from '../execution/worker/worker-server.js';
import { createRemoteWorkbenchHttpTransport } from '../execution/worker/worker-http-transport.js';
import { readCanonicalProjectFileBytes } from './adapters/canonical-host-file-adapter.js';
import { runFileRoundtripCanary } from './file-roundtrip-canary.js';

it('roundtrips through a real HTTP Worker and canonical byte reader (not user API)',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'roundtrip-worker-'));
 let worker: http.Server | undefined;
 try {
  const factory=createRemoteWorkbenchWorkerServer({workerId:'canary-worker',token:'synthetic-token',projects:{p:root},isolationProfile:'legacy-skill-dependent'});
  worker=factory;
  await new Promise<void>(resolve=>worker!.listen(0,'127.0.0.1',resolve));
  const address=worker.address();if(!address || typeof address==='string')throw Error('address');
  const transport=createRemoteWorkbenchHttpTransport({workerId:'canary-worker',baseUrl:`http://127.0.0.1:${address.port}`,token:'synthetic-token',projectRoot:root});
  let jobId=0;
  const report=await runFileRoundtripCanary({
   execute:async command=>{
    const result=await transport.execute({spec:{jobId:++jobId,projectId:'p',actorUserId:1,sessionId:'11111111-1111-4111-8111-111111111111',command,cwd:'/workspace',timeoutSec:10,workbenchRevision:null,environmentKeys:[]},credentials:{},signal:new AbortController().signal,onStdout:()=>{},onStderr:()=>{}});
    return {exitCode:result.execResult.exit_code,stdout:result.execResult.stdout};
   },
   read:async relativePath=>readCanonicalProjectFileBytes(root,relativePath,4096).toString('utf8'),
  });
  expect(report).toMatchObject({status:'PASS',cleanup:'verified'});
  expect(await fs.readdir(root)).toEqual([]);
 } finally {
  if(worker) await new Promise<void>(resolve=>worker!.close(()=>resolve()));
  await fs.rm(root,{recursive:true,force:true});
 }
});
