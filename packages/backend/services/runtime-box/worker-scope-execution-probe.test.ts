import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkerMaintenanceGate } from './worker-maintenance-gate.js';
import { assertScopeBackendIdentity, assertScopeBackendSocketOwner, captureScopeExecuteRun, createBackendScopeSharedWriteProbe, createScopeProjectExecutionClient, createWorkerScopeExecutionProbe, readScopeProbeContext, requireEmptyScopeProbeRequest, scopeProbeDirectory, type ScopeProbeInstallation } from './worker-scope-execution-probe.js';
import { assertScopeExecutionBinding, protectedPath, type AssignmentOperation } from '../../scripts/worker-scope-assignment-lifecycle.js';
const exec=promisify(execFile);
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const f of cleanups.splice(0).reverse())await f();});
function fixture(){
  const root=fs.mkdtempSync(`/run/user/${process.getuid!()}/scope-exec-`);
  cleanups.push(async()=>fs.rmSync(root,{recursive:true,force:true}));
  const project=path.join(root,'project');fs.mkdirSync(project);const st=fs.statSync(project);
  const stateFile=path.join(root,'state.json');
  const op={kind:'scope-assignment',version:1,id:randomUUID(),projectId:'new',workerId:'w',deploymentId:'test',leaseOwner:'lease',phase:'probe-intent',oldScope:{},newScope:{new:project},oldJti:'old',newJti:'new',rootIdentity:{dev:st.dev,ino:st.ino},oldPid:1,livePid:process.pid,executionNonce:randomUUID(),newConfigSha256:'config'} as AssignmentOperation;
  const save=()=>fs.writeFileSync(stateFile,JSON.stringify({version:1,owner:op.id,operation:op}),{mode:0o644});save();
  const install:ScopeProbeInstallation={stateFile,workerId:'w',projects:op.newScope,assertTrustedState:protectedPath};
  const gate=new WorkerMaintenanceGate(stateFile);const commands:string[]=[];let failCommand=false;
  const worker=createWorkerScopeExecutionProbe({...install,gate,execute:async i=>{
    commands.push(i.command);if(failCommand)throw Error('CHILD_FAILED');
    const r=await exec('sh',['-c',i.command],{cwd:i.root,env:{PATH:process.env.PATH},timeout:10000,maxBuffer:16384,signal:i.signal});
    return {exitCode:0,stdout:r.stdout,stderr:r.stderr,cleanupComplete:true,processGroupExited:true};
  }});
  // Explicit simulated installed Backend mapping. No privilege changes or claim
  // of distinct-UID OS verification: real processes/files execute as test user.
  const backendEvidence={pid:process.pid+10000,uid:process.getuid!()+1,gid:process.getgid!()+1,startTicks:'100'};
  const backend=createBackendScopeSharedWriteProbe({...install,backendPolicyFile:path.join(root,'not-installed'),identity:()=>backendEvidence});
  return {root,project,stateFile,op,save,install,gate,worker,backend,backendEvidence,commands,failCommand:()=>{failCommand=true;},dir:()=>path.join(project,scopeProbeDirectory(readScopeProbeContext(install,op.id)))};
}
async function server(handler:(action:string,owner:string)=>unknown){
  const s=http.createServer(async(req,res)=>{
    if(req.headers.authorization!=='Bearer synthetic-test-token'){res.writeHead(401).end();return;}
    try{
      const match=/^\/v1\/maintenance\/(?:project-execution|backend-shared-write)\/(prepare|verify|cleanup|abort|exchange|cleaned)$/.exec(req.url??'');
      if(req.method!=='POST'||!match)throw Error('ROUTE');const owner=requireEmptyScopeProbeRequest(req);
      const data=await handler(match[1],owner);res.setHeader('content-type','application/json');res.end(JSON.stringify(data));
    }catch{res.writeHead(409).end('{"error":"REJECTED"}');}
  });
  await new Promise<void>(resolve=>s.listen(0,'127.0.0.1',resolve));
  cleanups.push(async()=>{s.closeAllConnections();await new Promise<void>((resolve,reject)=>s.close(e=>e?reject(e):resolve()));});
  return `http://127.0.0.1:${(s.address() as import('node:net').AddressInfo).port}`;
}
async function client(f:ReturnType<typeof fixture>,verify=async(e:unknown)=>{expect(e).toEqual(f.backendEvidence);}){
  const workerUrl=await server((a,o)=>f.worker.handle(a as any,o));const backendUrl=await server((a,o)=>f.backend.handle(a as any,o));
  const run=createScopeProjectExecutionClient({...f.install,workerUrl,backendUrl,backendPolicyFile:path.join(f.root,'not-installed'),workerToken:async()=>'synthetic-test-token',backendToken:async()=>'synthetic-test-token',verifyBackendPeer:verify});
  return {run,workerUrl,backendUrl};
}

describe('fixed Project execution / Backend shared-write',()=>{
  it('real HTTP + child + files complete three-way exchange and cleanup with exact receipt',async()=>{
    const f=fixture();const {run}=await client(f);const receipt=await run(f.op.id);
    expect(receipt).toMatchObject({nonce:f.op.executionNonce,pid:process.pid,rootIdentity:f.op.rootIdentity,commandVerified:true,backendSharedWriteVerified:true,cleaned:true});
    assertScopeExecutionBinding(f.op,receipt);
    expect(f.commands).toHaveLength(3);expect(fs.readdirSync(f.project)).toEqual([]);expect(f.gate.snapshot()).toEqual({draining:true,activeRequests:0});
  });
  it('unproven Backend peer prevents receipt and cleans known Worker scratch',async()=>{
    const f=fixture();const {run}=await client(f,async()=>{throw Error('BACKEND_PEER_UNPROVEN');});
    await expect(run(f.op.id)).rejects.toThrow('BACKEND_PEER_UNPROVEN');expect(fs.readdirSync(f.project)).toEqual([]);
  });
  it('same Backend and command UID is not a separated Backend identity proof',async()=>{
    const f=fixture();f.backendEvidence.uid=process.getuid!();const {run}=await client(f);
    await expect(run(f.op.id)).rejects.toThrow('BACKEND_NOT_SEPARATED');expect(fs.readdirSync(f.project)).toEqual([]);
  });
  it('default production Backend identity rejects test policy instead of successful fallback',()=>{
    const f=fixture();expect(()=>assertScopeBackendIdentity(f.stateFile)).toThrow();
    const backend=createBackendScopeSharedWriteProbe({...f.install,backendPolicyFile:f.stateFile});
    expect(()=>backend.handle('exchange',f.op.id)).toThrow();
  });
  it.each(['projectId','livePid','executionNonce','leaseOwner'])('changed journal %s rejects continuation',async(key)=>{
    const f=fixture();await f.worker.handle('prepare',f.op.id);
    (f.op as any)[key]=key==='livePid'?process.pid+1:randomUUID();f.save();
    await expect(f.worker.handle('verify',f.op.id)).rejects.toThrow();expect(f.gate.snapshot().draining).toBe(true);
  });
  it('root replacement is rejected before child invocation',async()=>{
    const f=fixture();fs.renameSync(f.project,f.project+'-old');fs.mkdirSync(f.project);
    await expect(f.worker.handle('prepare',f.op.id)).rejects.toThrow('ROOT_REPLACED');expect(f.commands).toHaveLength(0);
  });
  it('pre-existing scratch is not adopted or deleted',async()=>{
    const f=fixture();fs.mkdirSync(f.dir());fs.writeFileSync(path.join(f.dir(),'keep'),'unrelated');
    await expect(f.worker.handle('prepare',f.op.id)).rejects.toThrow();await expect(f.worker.handle('abort',f.op.id)).rejects.toThrow('CLEANUP_REQUIRES_REVIEW');
    expect(fs.readFileSync(path.join(f.dir(),'keep'),'utf8')).toBe('unrelated');
  });
  it('symlink shared file is rejected and target stays untouched',async()=>{
    const f=fixture();await f.worker.handle('prepare',f.op.id);const outside=path.join(f.root,'outside');fs.writeFileSync(outside,'keep');
    fs.unlinkSync(path.join(f.dir(),'shared'));fs.symlinkSync(outside,path.join(f.dir(),'shared'));
    expect(()=>f.backend.handle('exchange',f.op.id)).toThrow();await expect(f.worker.handle('abort',f.op.id)).rejects.toThrow();expect(fs.readFileSync(outside,'utf8')).toBe('keep');
  });
  it('unknown scratch content blocks cleanup rather than recursive rm',async()=>{
    const f=fixture();await f.worker.handle('prepare',f.op.id);fs.writeFileSync(path.join(f.dir(),'user-file'),'keep');
    await expect(f.worker.handle('abort',f.op.id)).rejects.toThrow();expect(fs.readFileSync(path.join(f.dir(),'user-file'),'utf8')).toBe('keep');
  });
  it('verify before Backend write fails; owner stays fenced',async()=>{
    const f=fixture();await f.worker.handle('prepare',f.op.id);await expect(f.worker.handle('verify',f.op.id)).rejects.toThrow();expect(f.gate.snapshot().draining).toBe(true);
  });
  it('concurrent or repeated prepare never creates a second scratch',async()=>{
    const f=fixture();const first=f.worker.handle('prepare',f.op.id);await expect(f.worker.handle('prepare',f.op.id)).rejects.toThrow('BUSY');await first;
    await expect(f.worker.handle('prepare',f.op.id)).rejects.toThrow('BUSY');expect(fs.readdirSync(f.project)).toHaveLength(1);
  });
  it.each(['?command=id','?projectId=foreign'])('HTTP route rejects query %s',async(query)=>{
    const f=fixture();const {workerUrl}=await client(f);const r=await fetch(`${workerUrl}/v1/maintenance/project-execution/prepare${query}`,{method:'POST',headers:{authorization:'Bearer synthetic-test-token','x-tower-maintenance-owner':f.op.id}});
    expect(r.status).toBe(409);expect(f.commands).toHaveLength(0);
  });
  it('HTTP rejects arbitrary body/env headers and missing authentication',async()=>{
    const f=fixture();const {workerUrl}=await client(f);const url=`${workerUrl}/v1/maintenance/project-execution/prepare`;
    for(const opts of [{body:'{"command":"id"}'},{headers:{'x-tower-env':'bad'}}]){
      const r=await fetch(url,{method:'POST',...opts,headers:{authorization:'Bearer synthetic-test-token','x-tower-maintenance-owner':f.op.id,...opts.headers}});expect(r.status).toBe(409);
    }
    expect((await fetch(url,{method:'POST'})).status).toBe(401);expect(f.commands).toHaveLength(0);
  });
  it('tampered execution binding cannot be accepted for another nonce/lease/root',async()=>{
    const f=fixture();const {run}=await client(f);const receipt=await run(f.op.id);
    for(const change of [{executionNonce:randomUUID()},{leaseOwner:'other'},{rootIdentity:{dev:1,ino:1}}])expect(()=>assertScopeExecutionBinding({...f.op,...change},receipt)).toThrow('BINDING_REQUIRED');
  });
  it('completed nonce cannot be replayed in the same Worker session',async()=>{
    const f=fixture();const {run}=await client(f);await run(f.op.id);await expect(run(f.op.id)).rejects.toThrow('HTTP_FAILED');
    expect(fs.readdirSync(f.project)).toEqual([]);
  });
  it('cancelled prepare returns no success and does not run command',async()=>{
    const f=fixture();const abort=new AbortController();abort.abort();
    await expect(f.worker.handle('prepare',f.op.id,abort.signal)).rejects.toThrow('CANCELLED');expect(f.commands).toHaveLength(0);
  });
  it('failed protocol releases real request counter; owner-bound abort clears both peer sessions only after absence',async()=>{
    const f=fixture();await f.worker.handle('prepare',f.op.id);expect(f.gate.snapshot().activeRequests).toBe(0);
    f.backend.handle('exchange',f.op.id);await f.worker.handle('abort',f.op.id);f.backend.handle('abort',f.op.id);
    f.op.id=randomUUID();f.op.executionNonce=randomUUID();f.save();
    await f.worker.handle('prepare',f.op.id);expect(()=>f.backend.handle('exchange',f.op.id)).not.toThrow();
    await f.worker.handle('abort',f.op.id);f.backend.handle('abort',f.op.id);expect(f.gate.snapshot()).toEqual({draining:true,activeRequests:0});
  });
  it('response loss after prepare can be owner-aborted without replaying execution',async()=>{
    const f=fixture();await f.worker.handle('prepare',f.op.id); // discard response
    await f.worker.handle('abort',f.op.id);f.backend.handle('abort',f.op.id);
    expect(fs.readdirSync(f.project)).toEqual([]);expect(f.gate.snapshot().activeRequests).toBe(0);
  });
  it('failed prepare leaves only actual filesystem residue, not a permanent active request count',async()=>{
    const f=fixture();f.failCommand();await expect(f.worker.handle('prepare',f.op.id)).rejects.toThrow();
    expect(f.gate.snapshot().activeRequests).toBe(0);await f.worker.handle('abort',f.op.id);f.backend.handle('abort',f.op.id);
  });
  it.each(['127.0.0.1','0.0.0.0'])('actual IPv4 %s listener inode belongs to current process',async(host)=>{
    const s=http.createServer((_req,res)=>res.end('ok'));await new Promise<void>(r=>s.listen(0,host,r));
    try{assertScopeBackendSocketOwner(process.pid,process.getuid!(),(s.address() as any).port);
      expect(()=>assertScopeBackendSocketOwner(process.pid,process.getuid!()+1,(s.address() as any).port)).toThrow('UNPROVEN');
    }finally{s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}
  });
  it('normal run NDJSON parser requires completed non-cancelled result',async()=>{
    const r=await captureScopeExecuteRun(async res=>{res.end(JSON.stringify({type:'result',result:{execResult:{exit_code:0,stdout:'ok',stderr:'',timed_out:false},cancellation:{requested:false,processGroupExited:true}}})+'\n');});expect(r.stdout).toBe('ok');
    await expect(captureScopeExecuteRun(async res=>{res.end('{"type":"error"}\n');})).rejects.toThrow('EXECUTION_FAILED');
  });
});
