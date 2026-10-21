import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db/pg-repo.js', () => ({ queryOne: vi.fn() }));
vi.mock('../config.js', () => ({ config: { jwtSecret: 'runtime-observer-synthetic-signing-key' } }));
import { queryOne } from '../db/pg-repo.js';
import { issueWorkbenchWorkerIdentity } from '../services/runtime-box/workbench-worker-identity.js';
import { acquireScopeMutationLock, digest, type AssignmentInput } from './worker-scope-assignment-lifecycle.js';
import { createWorkerScopeRuntimeObserver, readScopeDbEvidence, readScopeProcess, scopeCgroupProcesses, scopeLockHeld, scopeUidProcesses, type ScopeRuntimePolicy, type ProcessEvidence, type DbRuntimeEvidence } from './worker-scope-runtime-observer.js';
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function directory() { const root = fs.mkdtempSync(`/run/user/${process.getuid!()}/scope-observer-`); roots.push(root); return root; }
function fixture() {
  const root = directory(); const project = path.join(root,'projects/new'); fs.mkdirSync(project,{recursive:true});
  const store = '/nix/store/' + 'a'.repeat(32) + '-test';
  const c: ScopeRuntimePolicy = { version:1,workerId:'w',deploymentId:'test',executionUid:44001,executionGid:44001,
    workerUnit:'tower-workbench-worker-w.service',heartbeatUnit:'tower-workbench-worker-w-heartbeat.service',
    coordinatorUnit:'tower-scope-controller.service',workerFragment:path.join(root,'worker.service'),heartbeatFragment:path.join(root,'heartbeat.service'),coordinatorFragment:path.join(root,'coordinator.service'),
    baseUrl:'http://127.0.0.1:43125',controlPlaneUrl:'http://127.0.0.1:32364',storePath:store,sourceRev:'b'.repeat(40),
    configFile:path.join(root,'worker.json'),identityFile:path.join(root,'identity.jwt'),stateFile:path.join(root,'state.json'),lockFile:path.join(root,'lock'),backupDirectory:path.join(root,'backups'),projectsRoot:path.join(root,'projects') };
  fs.mkdirSync(c.backupDirectory,{mode:0o700}); for(const file of [c.workerFragment,c.heartbeatFragment,c.coordinatorFragment,c.lockFile]) fs.writeFileSync(file,'fixture',{mode:0o644});
  const token = issueWorkbenchWorkerIdentity({workerId:'w',projectIds:['old'],capabilities:['shell']});
  const oldScope={old:path.join(root,'projects/old')};
  fs.writeFileSync(c.configFile,JSON.stringify({workerId:'w',host:'127.0.0.1',port:43125,projects:oldScope}),{mode:0o640});
  fs.writeFileSync(c.identityFile,token.token,{mode:0o640}); fs.writeFileSync(c.stateFile,JSON.stringify({version:1,owner:null,phase:'idle'}),{mode:0o644});
  const policyFile=path.join(root,'policy.json'); fs.writeFileSync(policyFile,JSON.stringify(c),{mode:0o600});
  const now=Date.now(); for(const file of [c.configFile,c.identityFile]) fs.utimesSync(file,new Date(now-10000),new Date(now-10000));
  const input: AssignmentInput={workerId:'w',deploymentId:'test',projectId:'new',root:project,leaseOwner:'lease',configFile:c.configFile,identityFile:c.identityFile,stateFile:c.stateFile,lockFile:c.lockFile,backupDirectory:c.backupDirectory};
  const env={TOWER_WORKER_MAINTENANCE_STATE:c.stateFile,TOWER_REMOTE_WORKER_CONFIG:c.configFile};
  const worker:ProcessEvidence={pid:12001,uid:44001,gid:44001,startedAt:now-5000,startTicks:'100',argv:[store+'/lib/tower/dist/backend/packages/backend/services/runtime-box/remote-workbench-worker-entrypoint.js'],environment:env,cgroup:'/system.slice/worker'};
  const beat:ProcessEvidence={...worker,pid:12002,environment:{TOWER_LOCAL_WORKER_ID:'w',TOWER_LOCAL_WORKER_DEPLOYMENT_ID:'test',TOWER_LOCAL_WORKER_IDENTITY_FILE:c.identityFile,TOWER_LOCAL_WORKER_BASE_URL:c.baseUrl,TOWER_LOCAL_WORKER_PROJECT_IDS:'old'},argv:[store+'/lib/tower/dist/backend/packages/backend/scripts/local-workbench-worker-heartbeat.js'],cgroup:'/system.slice/heartbeat'};
  const baseUnit={ActiveState:'active',User:'worker',KillMode:'process',SendSIGKILL:'no',TimeoutStopUSec:'infinity'};
  const writable=[...new Set([path.dirname(c.configFile),path.dirname(c.stateFile),c.backupDirectory,path.dirname(c.heartbeatFragment)])].join(' ');
  const units:Record<string,Record<string,string>>={
    [c.workerUnit]:{...baseUnit,MainPID:String(worker.pid),ControlGroup:worker.cgroup,FragmentPath:c.workerFragment},
    [c.heartbeatUnit]:{...baseUnit,MainPID:String(beat.pid),ControlGroup:beat.cgroup,FragmentPath:c.heartbeatFragment},
    [c.coordinatorUnit]:{...baseUnit,User:'root',ControlGroup:'/system.slice/coordinator',FragmentPath:c.coordinatorFragment,ProtectSystem:'strict',ProtectHome:'read-only',NoNewPrivileges:'yes',ReadWritePaths:writable} };
  const db:DbRuntimeEvidence={worker_id:'w',deployment_id:'test',base_url:c.baseUrl,project_ids:['old'],draining:false,reservations:0,services:0,heartbeat_at:now,observed_at:now,
    active:[{jti:token.identity.jti,project_ids:['old'],capabilities:['shell']}],identities:[{jti:token.identity.jti,revoked_at:null,replaced_by_jti:null,project_ids:['old']}]};
  let held=true, dbError=false, extraUid=false, extraCgroup=false, activeRequests=0;
  const lstat=fs.lstatSync.bind(fs); const stat=fs.statSync.bind(fs); const read=fs.readFileSync.bind(fs);
  // Simulate protected installed root metadata only. No root/chown/real unit access.
  vi.spyOn(fs,'lstatSync').mockImplementation(((p:any,...args:any[])=>{ const value=lstat(p,...args as []); return Object.assign(value,{uid:0}); }) as any);
  vi.spyOn(fs,'statSync').mockImplementation(((p:any,...args:any[])=>{ const value=stat(p,...args as []); if(String(p)===c.identityFile) Object.assign(value,{gid:44001}); return value; }) as any);
  vi.spyOn(fs,'readFileSync').mockImplementation(((p:any,...args:any[])=> String(p)===store+'/share/tower/release-manifest.json'?JSON.stringify({sourceRev:c.sourceRev}):read(p,...args as [])) as any);
  const ports={uid:()=>0,process:async(pid:number)=>pid===process.pid?{...worker,pid,uid:0,cgroup:'/system.slice/coordinator'}:pid===worker.pid?{...worker}:pid===beat.pid?{...beat}:(()=>{throw Error('unknown pid')})(),
    unit:async(name:string)=>units[name], db:async()=>{if(dbError)throw Error('DB_READ_FAILED');return db;},
    http:async(url:string)=>url.endsWith('/api/health')?{status:'ok',sourceRev:c.sourceRev}:{version:1,workerId:'w',pid:worker.pid,storePath:store,draining:!!JSON.parse(read(c.stateFile,'utf8')).owner,activeRequests},
    lockHeld:()=>held,uidProcesses:()=>extraUid?[worker.pid,beat.pid,999]:[worker.pid,beat.pid],cgroupProcesses:(group:string)=>[group===worker.cgroup?worker.pid:beat.pid,...(extraCgroup?[999]:[])],project:async()=>true};
  const adapter=createWorkerScopeRuntimeObserver({policyFile,transportToken:async()=>'',ports});
  const op:any={version:1,kind:'scope-assignment',id:'owner',workerId:'w',deploymentId:'test',projectId:'new',leaseOwner:'lease',oldJti:token.identity.jti,oldPid:worker.pid,phase:'draining',oldScope,newScope:{...oldScope,new:project},config:{sha256:digest(read(c.configFile)),path:c.configFile}};
  const own=()=>fs.writeFileSync(c.stateFile,JSON.stringify({version:1,owner:'owner',operation:op}));
  return {c,input,worker,beat,db,units,op,own,adapter,ports,policyFile,
    extra:(which:string)=>{if(which==='uid')extraUid=true;else if(which==='cgroup')extraCgroup=true;else if(which==='requests')activeRequests=1;},
    loseLock:()=>{held=false;},dbFail:()=>{dbError=true;},read};
}

describe('read-only runtime authority/admission/owned transition',()=>{
  it('authorizes exact installed policy and observes actual-process/file-time bindings',async()=>{
    const f=fixture();await f.adapter.authorize(f.input);expect(await f.adapter.observe()).toMatchObject({pid:f.worker.pid,heartbeatPid:f.beat.pid,identityJti:f.db.active[0].jti});
    f.own();expect(await f.adapter.idle('owner')).toBe(true);
  });
  it.each(['uid','cgroup','requests','reservations','services','draining'])('defers %s occupancy without pretending idle',async(which)=>{
    const f=fixture();await f.adapter.authorize(f.input);f.own();if(which==='reservations'||which==='services') f.db[which]=1;else if(which==='draining')f.db.draining=true;else f.extra(which);
    expect(await f.adapter.idle('owner')).toBe(false);
  });
  it('allows stale known rotation window, but DB outage and unrelated linkage remain unknown',async()=>{
    const f=fixture();await f.adapter.authorize(f.input);f.op.newJti='replacement';f.op.phase='restart-intent';f.own();f.db.heartbeat_at-=60000;
    f.db.identities[0].revoked_at=new Date().toISOString();f.db.identities[0].replaced_by_jti='replacement';f.db.active=[{jti:'replacement',project_ids:['old','new'],capabilities:['shell']}];
    const context={mode:'owned-transition' as const,oldJti:f.op.oldJti,newJti:'replacement'};
    expect(await f.adapter.idle('owner',context)).toBe(true);
    await expect(f.adapter.idle('owner',{mode:'admission',oldJti:f.op.oldJti})).rejects.toThrow('STALE');
    f.db.identities[0].replaced_by_jti='unrelated';await expect(f.adapter.idle('owner',context)).rejects.toThrow('IDENTITY_UNKNOWN');
    f.dbFail();await expect(f.adapter.idle('owner',context)).rejects.toThrow('DB_READ_FAILED');
  });
  it('process or DB observation errors never become idle success',async()=>{
    const f=fixture();const ports={...f.ports,cgroupProcesses:()=>{throw Error('CGROUP_UNREADABLE');}};
    const a=createWorkerScopeRuntimeObserver({policyFile:f.policyFile,transportToken:async()=>'',ports});await a.authorize(f.input);f.own();
    await expect(a.idle('owner')).rejects.toThrow('CGROUP_UNREADABLE');
  });
  it('PID identity change between observations fails closed',async()=>{
    const f=fixture();let reads=0;const ports={...f.ports,process:async(pid:number)=>{
      const p=await f.ports.process(pid);if(pid===f.worker.pid&&++reads>1)return {...p,startTicks:'different'};return p;
    }};
    const a=createWorkerScopeRuntimeObserver({policyFile:f.policyFile,transportToken:async()=>'',ports});await a.authorize(f.input);f.own();
    await expect(a.idle('owner')).rejects.toThrow('PROCESS_CHANGED');
  });
  it('does not infer loaded JWT from rewritten disk file',async()=>{
    const f=fixture();await f.adapter.authorize(f.input);fs.utimesSync(f.c.identityFile,new Date(),new Date());
    expect((await f.adapter.observe()).heartbeatIdentityJti).toBe('');
  });
  it.each(['lock','fence','store','stop','writable','root'])('rejects %s authority/provenance mismatch',async(which)=>{
    const f=fixture();if(which==='writable')f.units[f.c.coordinatorUnit].ReadWritePaths='/';if(which==='root')f.ports.uid=()=>1001;
    const a=which==='root'?createWorkerScopeRuntimeObserver({policyFile:f.policyFile,transportToken:async()=>'',ports:f.ports}):f.adapter;
    if(which==='writable'||which==='root'){await expect(a.authorize(f.input)).rejects.toThrow();return;}
    await a.authorize(f.input);f.own();if(which==='lock')f.loseLock();if(which==='fence')f.worker.environment.TOWER_WORKER_MAINTENANCE_STATE='/wrong';if(which==='store')f.worker.argv=['/wrong'];if(which==='stop')f.units[f.c.workerUnit].SendSIGKILL='yes';
    await expect(a.idle('owner')).rejects.toThrow();
  });
  it('refuses stale original identity, negative/unknown counts and changed PID',async()=>{
    const f=fixture();await f.adapter.authorize(f.input);f.own();f.db.heartbeat_at-=60000;await expect(f.adapter.idle('owner')).rejects.toThrow('STALE');
    f.db.reservations=NaN;await expect(f.adapter.idle('owner')).rejects.toThrow('DB_EVIDENCE_INVALID');
  });
});

describe('real bounded /proc, flock, cgroup files and SQL boundary',()=>{
  it('reads temporary child PID/start/env without returning arbitrary environment',async()=>{
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{...process.env,TOWER_LOCAL_WORKER_ID:'fixture',OBSERVER_SYNTHETIC_SECRET:'do-not-return'},stdio:'ignore'});
    try { const info=await readScopeProcess(child.pid!);expect(info.pid).toBe(child.pid);expect(info.uid).toBe(process.getuid!());expect(info.startedAt).toBeGreaterThan(Date.now()-5000);
      expect(info.environment).toEqual({TOWER_LOCAL_WORKER_ID:'fixture'});expect(scopeUidProcesses(process.getuid!())).toContain(child.pid);
    } finally {const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await done;}
  });
  it('proves current-process EX lock from fdinfo and detects release',()=>{
    const root=directory();const file=path.join(root,'lock');fs.writeFileSync(file,'',{mode:0o600});expect(scopeLockHeld(file)).toBe(false);
    const release=acquireScopeMutationLock(file);try {expect(scopeLockHeld(file)).toBe(true);}finally{release();}expect(scopeLockHeld(file)).toBe(false);
  });
  it('walks actual nested cgroup fixture files; missing observation is not empty success',()=>{
    const root=directory();fs.mkdirSync(path.join(root,'worker/sub'),{recursive:true});fs.writeFileSync(path.join(root,'worker/cgroup.procs'),'12\n');fs.writeFileSync(path.join(root,'worker/sub/cgroup.procs'),'14\n');
    expect(scopeCgroupProcesses('/worker',root)).toEqual([12,14]);expect(()=>scopeCgroupProcesses('/missing',root)).toThrow('UNKNOWN');
  });
  it('uses read-only SQL counts preserving expired reservations and surfaces DB failure',async()=>{
    vi.mocked(queryOne).mockResolvedValueOnce({heartbeat_at:'1',observed_at:'2'} as any);
    await readScopeDbEvidence('w','test');const sql=vi.mocked(queryOne).mock.calls.at(-1)![0];expect(sql).toContain("r.state='reserved'");expect(sql).not.toContain('r.expires_at');expect(sql).toContain("s.status NOT IN ('stopped','failed','expired','error')");expect(sql).not.toMatch(/UPDATE|INSERT|DELETE/);
    vi.mocked(queryOne).mockRejectedValueOnce(Error('private connection detail'));await expect(readScopeDbEvidence('w','test')).rejects.toThrow('DB_UNAVAILABLE');
  });
});
