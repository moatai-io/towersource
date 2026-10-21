import { verifyPersistedScopeProbe } from '../services/runtime-box/worker-scope-execution-probe.js';
import { executionBindingDigest } from './worker-scope-assignment-lifecycle.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db/pg-repo.js', () => ({ query: vi.fn(), queryOne: vi.fn(), transaction: vi.fn(), withClient: vi.fn() }));
vi.mock('../config.js', () => ({ config: { jwtSecret: 'synthetic-test-only-worker-signing-key' } }));
import { query, queryOne, transaction, withClient } from '../db/pg-repo.js';
import { issueWorkbenchWorkerIdentity, verifyWorkbenchWorkerIdentity } from '../services/runtime-box/workbench-worker-identity.js';
import { createWorkerScopeAssignmentDbAdapter, withUnwiredScopeRuntime } from './worker-scope-assignment-db-adapter.js';
import { createWorkerScopeHeartbeatAdapter } from './worker-scope-heartbeat-adapter.js';
import { WorkerMaintenanceGate } from '../services/runtime-box/worker-maintenance-gate.js';
import { WorkerScopeAssignmentLifecycle, acquireScopeMutationLock, digest, scopeDigest, type AssignmentInput, type AssignmentOperation } from './worker-scope-assignment-lifecycle.js';

const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
beforeEach(() => vi.clearAllMocks());
function fixture(fileAuthorityReady = true, installedMode: 0o600 | 0o640 = 0o600) {
  const root = fs.mkdtempSync(`/run/user/${process.getuid!()}/scope-db-test-`); roots.push(root);
  const stage = path.join(root, 'stage'); fs.mkdirSync(stage, { mode: 0o700 });
  const input: AssignmentInput = { workerId: 'worker', deploymentId: 'test', projectId: 'new', leaseOwner: 'lease-a', root: path.join(root, 'new'),
    configFile: path.join(root, 'config.json'), identityFile: path.join(root, 'identity.jwt'), stateFile: path.join(root, 'state.json'), lockFile: path.join(root, 'lock'), backupDirectory: root };
  fs.writeFileSync(input.lockFile, '', { mode: 0o644 });
  const oldScope = { old: path.join(root, 'old') }; const newScope = { ...oldScope, new: input.root };
  const original = issueWorkbenchWorkerIdentity({ workerId: 'worker', projectIds: ['old'], capabilities: ['shell', 'custom-capability'], expiresIn: '1h' });
  fs.mkdirSync(input.root);
  fs.writeFileSync(input.identityFile, original.token + '\n', { mode: installedMode }); fs.writeFileSync(input.configFile, JSON.stringify({ projects: oldScope }), { mode: 0o640 });
  const stat = fs.statSync(input.identityFile);
  const op: AssignmentOperation = { kind: 'scope-assignment', version: 1, id: randomUUID(), workerId: 'worker', deploymentId: 'test', projectId: 'new', leaseOwner: 'lease-a', phase: 'stage-intent',
    rootIdentity: { dev: 1, ino: 1 }, oldScope, newScope, oldJti: original.identity.jti, oldPid: 10, storePath: '/nix/store/test', newConfigSha256: 'test',
    config: { path: input.configFile, backup: '', sha256: '', uid: stat.uid, gid: stat.gid, mode: 0o640 },
    identity: { path: input.identityFile, backup: '', sha256: '', uid: stat.uid, gid: stat.gid, mode: installedMode } };
  const save = () => fs.writeFileSync(input.stateFile, JSON.stringify({ version: 1, owner: op.id, phase: op.phase, operation: op }), { mode: 0o644 }); save();
  let db: any = { identities: [{ jti: original.identity.jti, worker_id: 'worker', project_ids: ['old'], capabilities: ['custom-capability', 'shell'], expires_at: original.identity.expiresAt, revoked_at: null, replaced_by_jti: null }],
    desire: { status: 'preparing', desired_worker_id: 'worker', lease_owner: 'lease-a', completed_at: null }, binding: null, settings: null, rollout: null };
  let loseReply = false; let failComplete = false; const sqls: Array<{ sql: string; values: any[]; transaction: boolean }> = [];
  const execute = async (store: any, sql: string, values: any[] = [], tx = false): Promise<any[]> => {
    sqls.push({ sql, values, transaction: tx });
    if(sql.includes('pg_try_advisory_xact_lock'))return [{locked:true}];
    if(sql.includes('FOR UPDATE OF d,p')) {
      const candidates=[...(store.excluded??[]),{project_id:'new',root_path:input.root,...store.desire}];
      const eligible=candidates.find(r=>r.project_id===values[2] && r.root_path===values[3] && r.status==='pending' && !r.archived && !r.system_key && (!r.lifecycle_status||r.lifecycle_status==='active') && !store.binding);
      return eligible?[eligible]:[];
    }
    if(sql.includes("SET status='preparing',attempt=attempt+1")) {
      if(values[0]!=='new'||store.desire.status!=='pending')return [];
      store.desire={...store.desire,status:'preparing',lease_owner:values[1]};return [{project_id:'new',...store.desire}];
    }
    if(sql.includes(' AS bound'))return [{...store.desire,bound:!!store.binding}];
    if (sql.includes('FROM runtime_box_workbench_worker_identities')) {
      if (sql.includes('replaced_by_jti=$1')) return store.identities.filter((r: any) => r.replaced_by_jti === values[0]);
      if (sql.includes('WHERE jti=$1')) return store.identities.filter((r: any) => r.jti === values[0]);
      return store.identities.filter((r: any) => r.worker_id === values[0] && !r.revoked_at && Date.parse(r.expires_at) > Date.now());
    }
    if (sql.includes('INSERT INTO runtime_box_workbench_worker_identities')) {
      const row = { jti: values[0], worker_id: values[1], project_ids: values[2], capabilities: values[3], expires_at: values[5], revoked_at: null, replaced_by_jti: null }; store.identities.push(row); return [row];
    }
    if (sql.includes('UPDATE runtime_box_workbench_worker_identities')) { const row = store.identities.find((r: any) => r.jti === values[0]); row.revoked_at = 'now'; row.replaced_by_jti = values[1]; return [row]; }
    if (sql.includes('LEFT JOIN project_compute_deployment_bindings')) return [{ ...store.desire,
      binding_project: store.binding?.project, binding_worker: store.binding?.worker, binding_workstation: store.binding?.workstation, binding_authority: store.binding?.authority,
      settings_worker: store.settings?.worker, settings_workstation: store.settings?.workstation, settings_authority: store.settings?.authority,
      rollout_status: store.rollout?.status, rollout_cohort: store.rollout?.cohort, rollout_reason: store.rollout?.reason }];
    if (sql.includes('FROM project_worker_assignment_desires')) return [store.desire];
    if (sql.includes('SELECT project_id FROM project_compute_deployment_bindings')) return store.binding ? [{ project_id: store.binding.project }] : [];
    if (sql.includes('INSERT INTO project_compute_deployment_bindings')) { if (store.binding) return []; store.binding = { project: values[0], worker: values[2], workstation: true, authority: values[3] }; return [{ project_id: values[0] }]; }
    if (sql.includes('INSERT INTO project_compute_settings')) { store.settings = { worker: values[1], workstation: values[4], authority: values[2] }; return []; }
    if (sql.includes('INSERT INTO runtime_box_workbench_rollouts')) { store.rollout = { status: 'enabled', cohort: values[1], reason: values[2] }; return []; }
    if (sql.includes('UPDATE project_worker_assignment_desires')) {
      if (failComplete || store.desire.status !== 'preparing' || store.desire.lease_owner !== values[3] || store.desire.desired_worker_id !== values[2]) return [];
      store.desire = { ...store.desire, status: values[4] ?? 'active', last_error: values[5] ?? null, lease_owner: null, completed_at: 'now' }; return [{ project_id: 'new' }];
    }
    throw new Error('UNHANDLED_TEST_SQL');
  };
  vi.mocked(query).mockImplementation(async (sql, values) => execute(db, sql, values) as any);
  vi.mocked(queryOne).mockImplementation(async (sql, values) => (await execute(db, sql, values))[0]);
  vi.mocked(transaction).mockImplementation(async callback => {
    const copy = structuredClone(db); const client = { query: async (sql: string, values: any[]) => { const rows = await execute(copy, sql, values, true); return { rows, rowCount: rows.length }; } };
    const result = await callback(client as any); db = copy; if (loseReply && db.desire.status==='active') { loseReply = false; throw new Error('COMMIT_REPLY_LOST'); } return result;
  });
  vi.mocked(withClient).mockImplementation((client: any) => ({
    queryOne: async (sql: string, values: any[]) => (await client.query(sql, values)).rows[0],
    execute: async (sql: string, values: any[]) => ({ changes: (await client.query(sql, values)).rowCount }),
    query: async (sql: string, values: any[]) => (await client.query(sql, values)).rows,
  }) as any);
  const adapter = createWorkerScopeAssignmentDbAdapter({ input, actorUserId: 7, stagingDirectory: stage, fileAuthorityReady, installedIdentity: { uid: stat.uid, gid: stat.gid, mode: installedMode } });
  const bindingReady = () => { op.executionNonce=randomUUID(); op.newJti ??= randomUUID(); op.phase = 'binding-intent'; op.livePid = 11; op.probe = { owner: op.id, projectId: 'new', rootDigest: digest(input.root), pid: 11, scopeDigest: scopeDigest(newScope), cleaned: true }; op.executionReceipt = { ...op.probe, commandVerified: true, backendSharedWriteVerified: true,nonce:op.executionNonce!,operationDigest:executionBindingDigest(op),rootIdentity:op.rootIdentity,backend:{pid:99999,uid:2001,gid:2001,startTicks:'1'},commandUid:2002 }; save(); };
  return { root, input, stage, op, save, adapter, sqls, db: () => db, bindingReady, loseReply: () => { loseReply = true; }, failComplete: () => { failComplete = true; } };
}

import http from 'node:http';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { runScopeCli, type ScopeCliPorts } from './worker-scope-cli.js';
import { assertScopeCoordinatorEnvironment, planScopeHeartbeatRelocation, renderScopeCoordinatorUnit, validateScopeInstallationPolicy, type ScopeInstallationPolicy } from './worker-scope-installation.js';
import { chooseScopeAssignmentRoute } from './worker-scope-assignment-routing.js';
import { scopeLockHeld } from './worker-scope-runtime-observer.js';
import { createWorkerScopeExecutionProbe, createBackendScopeSharedWriteProbe, requireEmptyScopeProbeRequest } from '../services/runtime-box/worker-scope-execution-probe.js';
import { runWorkerScopeProjectProbe } from '../services/runtime-box/worker-scope-project-probe.js';
const exec=promisify(execFile);
const closers:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const f of closers.splice(0).reverse())await f();});
async function acceptance(){
 const f=fixture(true,0o640);f.db().desire.status='pending';f.db().desire.lease_owner=null;const cfg=path.join(f.root,'policy.json');
 const store='/nix/store/'+'a'.repeat(32)+'-test';const workerUnit='tower-workbench-worker-worker.service',heartbeatUnit='tower-workbench-worker-worker-heartbeat.service';
 const workerFragment=path.join(f.root,workerUnit),heartbeatFragment=path.join(f.root,heartbeatUnit);
 fs.writeFileSync(workerFragment,'[Service]\n');
 const unit=`[Service]\nEnvironment=TOWER_LOCAL_WORKER_ID=worker\nEnvironment=TOWER_LOCAL_WORKER_DEPLOYMENT_ID=test\nEnvironment=TOWER_LOCAL_WORKER_IDENTITY_FILE=${f.input.identityFile}\nEnvironment=TOWER_LOCAL_WORKER_PROJECT_IDS=old\n`;
 fs.writeFileSync(heartbeatFragment,unit);fs.writeFileSync(f.input.stateFile,JSON.stringify({version:1,owner:null,phase:'idle'}));
 const gate=new WorkerMaintenanceGate(f.input.stateFile);let loadedScope=f.op.oldScope;let workerPid=process.pid-1,beatPid=process.pid+100,started=Date.now()-5000,beatTime=Date.now();
 let loadedJti=f.op.oldJti;let currentRequest:http.IncomingMessage|undefined;let loseCommit=false,failUpload=false;
 let c:ScopeInstallationPolicy;
 const projects=new Proxy({} as Record<string,string>,{get:(_t,k)=>loadedScope[k],ownKeys:()=>Object.keys(loadedScope),getOwnPropertyDescriptor:()=>({enumerable:true,configurable:true})});
 const workerProbe=createWorkerScopeExecutionProbe({stateFile:f.input.stateFile,workerId:'worker',projects,gate,assertTrustedState:()=>{},execute:async i=>{
   const r=await exec('sh',['-c',i.command],{cwd:i.root,env:{PATH:process.env.PATH},signal:i.signal,timeout:10000});return {exitCode:0,stdout:r.stdout,stderr:r.stderr,cleanupComplete:true,processGroupExited:true};
 }});
 const backendIdentity={pid:process.pid+90000,uid:process.getuid!()+1,gid:process.getgid!()+1,startTicks:'1'};
 const backendProbe=createBackendScopeSharedWriteProbe({stateFile:f.input.stateFile,workerId:'worker',projects,backendPolicyFile:'test',assertTrustedState:()=>{},identity:()=>backendIdentity});
 const server=http.createServer(async(req,res)=>{try{
  if(req.headers.authorization!=='Bearer synthetic-test-token')throw Error('AUTH');
  if(req.url==='/api/health'){res.end(JSON.stringify({status:'ok',sourceRev:'b'.repeat(40)}));return;}
  if(req.url==='/v1/maintenance/status'){res.end(JSON.stringify({version:1,workerId:'worker',pid:workerPid,storePath:store,...gate.snapshot(),scopeProbeProtocol:'scope-execution-v1'}));return;}
  if(req.url==='/v1/maintenance/backend-shared-write/status'){res.end(JSON.stringify({version:1,workerId:'worker',protocol:'scope-shared-write-v1',backend:backendIdentity}));return;}
  const owner=requireEmptyScopeProbeRequest(req);
  if(req.url==='/v1/maintenance/smoke'){res.end(JSON.stringify({type:'result',result:{execResult:{exit_code:0,stdout:'MAINTENANCE_SMOKE_OK',timed_out:false},cancellation:{requested:false,processGroupExited:true}}})+'\n');return;}
  if(req.url==='/v1/maintenance/project-probe'){if(failUpload)throw Error('FIXTURE_UPLOAD_FAILED');res.end(JSON.stringify(await runWorkerScopeProjectProbe({stateFile:f.input.stateFile,workerId:'worker',projects,gate,owner,assertTrustedState:()=>{},resolveProjectFile:(r,p)=>path.join(r,p)})));return;}
  const m=/^\/v1\/maintenance\/(project-execution|backend-shared-write)\/(prepare|verify|cleanup|abort|exchange|cleaned)$/.exec(req.url??'');if(!m)throw Error('ROUTE');
  const result=m[1]==='project-execution'?await workerProbe.handle(m[2] as any,owner):backendProbe.handle(m[2] as any,owner);
  if(loseCommit&&m[2]==='cleaned')f.loseReply();res.end(JSON.stringify(result));
 }catch(e){res.writeHead(409).end(JSON.stringify({error:(e as Error).message}));}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));closers.push(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const url=`http://127.0.0.1:${(server.address() as any).port}`;
 c={version:1,workerId:'worker',deploymentId:'test',executionUid:process.getuid!(),executionGid:process.getgid!(),workerUnit,heartbeatUnit,workerFragment,heartbeatFragment,
 coordinatorUnit:'tower-worker-scope-worker.service',coordinatorFragment:path.join(f.root,'tower-worker-scope-worker.service'),
 configFile:f.input.configFile,identityFile:f.input.identityFile,stateFile:f.input.stateFile,lockFile:f.input.lockFile,backupDirectory:f.root,stagingDirectory:f.stage,
 projectsRoot:f.root,baseUrl:url,controlPlaneUrl:url,backendUrl:url,storePath:store,sourceRev:'b'.repeat(40),actorUserId:7,backendPolicyFile:path.join(f.root,'backend-policy.json'),environmentFile:path.join(f.root,'secrets'),nodeBinary:'/nix/store/'+'c'.repeat(32)+'-node/bin/node'};
 fs.writeFileSync(c.configFile,JSON.stringify({workerId:'worker',host:'127.0.0.1',port:Number(new URL(url).port),projects:loadedScope}));
 fs.writeFileSync(cfg,JSON.stringify(c));fs.writeFileSync(c.coordinatorFragment,'fixture');
 for(const file of [c.configFile,c.identityFile])fs.utimesSync(file,new Date(Date.now()-10000),new Date(Date.now()-10000));
 const stat=fs.statSync.bind(fs);vi.spyOn(fs,'statSync').mockImplementation(((p:any,...args:any[])=>{const st=stat(p,...args as []);st.uid=0;return st;}) as any);
 const fstat=fs.fstatSync.bind(fs);vi.spyOn(fs,'fstatSync').mockImplementation(((fd:any)=>{const st=fstat(fd);st.uid=0;return st;}) as any);vi.spyOn(fs,'fchownSync').mockImplementation(()=>{});
 const lstat=fs.lstatSync.bind(fs),read=fs.readFileSync.bind(fs);
 vi.spyOn(fs,'lstatSync').mockImplementation(((p:any,...args:any[])=>{const value=lstat(p,...args as []);value.uid=0;return value;}) as any);
 vi.spyOn(fs,'readFileSync').mockImplementation(((p:any,...args:any[])=>String(p)===store+'/share/tower/release-manifest.json'?JSON.stringify({sourceRev:c.sourceRev}):read(p,...args as [])) as any);
 const processEvidence=(pid:number)=>({pid,uid:pid===process.pid+900?0:c.executionUid,gid:c.executionGid,startedAt:started,startTicks:String(started),
 argv:[`${store}/lib/tower/dist/backend/packages/backend/${pid===beatPid?'scripts/local-workbench-worker-heartbeat.js':'services/runtime-box/remote-workbench-worker-entrypoint.js'}`],
 cgroup:pid===process.pid+900?'/system.slice/controller':pid===beatPid?'/system.slice/heartbeat':'/system.slice/worker',
 environment:pid===beatPid?{TOWER_LOCAL_WORKER_ID:'worker',TOWER_LOCAL_WORKER_DEPLOYMENT_ID:'test',TOWER_LOCAL_WORKER_IDENTITY_FILE:c.identityFile,TOWER_LOCAL_WORKER_BASE_URL:url,TOWER_LOCAL_WORKER_PROJECT_IDS:Object.keys(loadedScope).join(',')}:{TOWER_WORKER_MAINTENANCE_STATE:c.stateFile,TOWER_REMOTE_WORKER_CONFIG:c.configFile}});
 // Observer sees a controller PID coincident with fixture Worker PID. Return
 // controller evidence only on installation's first process(self) call per sample.
 let selfNextController=true;
 const ports:ScopeCliPorts={loadPolicy:()=>c,inspect:async()=>({policyDigest:digest(read(cfg)),sourceRev:c.sourceRev}),tokens:()=>({worker:'synthetic-test-token',backend:'synthetic-test-token'}),trustedState:()=>{},peer:async e=>{expect(e).toEqual(backendIdentity);},dbOptions:{installedIdentity:{uid:0,gid:process.getgid!(),mode:0o640}},
 candidate:async()=>({project_id:'new',root_path:f.input.root,status:'pending',lease_owner:null}),claim:async(_c,expected)=>{
   expect(scopeLockHeld(f.input.lockFile)).toBe(true);
   const journal=JSON.parse(fs.readFileSync(f.input.stateFile,'utf8'));expect(journal.operation.phase).toBe('claim-intent');expect(journal.operation.leaseOwner).toBe(expected.lease_owner);
   f.db().desire.status='preparing';f.db().desire.lease_owner=expected.lease_owner;
   return {...expected,status:'preparing'};
 },resolveClaim:async(_c,expected)=>f.db().desire.status==='preparing'&&f.db().desire.lease_owner===expected.lease_owner?'owned':f.db().desire.status==='pending'?'unclaimed':'ambiguous',
 observer:{uid:()=>0,project:async()=>true,lockHeld:scopeLockHeld,uidProcesses:()=>[workerPid,beatPid],cgroupProcesses:g=>[g.includes('heartbeat')?beatPid:workerPid],
 process:async pid=>{if(pid===process.pid&&selfNextController){selfNextController=false;return {...processEvidence(process.pid+900),pid:process.pid};}return processEvidence(pid);},
 unit:async name=>{if(name===c.coordinatorUnit){selfNextController=true;return {User:'root',ActiveState:'active',FragmentPath:c.coordinatorFragment,ControlGroup:'/system.slice/controller',ProtectSystem:'strict',ProtectHome:'read-only',NoNewPrivileges:'yes',ReadWritePaths:[...new Set([f.root,c.backupDirectory])].join(' ')};}
 return {ActiveState:'active',MainPID:String(name===workerUnit?workerPid:beatPid),FragmentPath:name===workerUnit?workerFragment:heartbeatFragment,ControlGroup:name===workerUnit?'/system.slice/worker':'/system.slice/heartbeat',KillMode:'process',SendSIGKILL:'no',TimeoutStopUSec:'infinity'};},
 http:async url=>url.endsWith('/api/health')?{status:'ok',sourceRev:c.sourceRev}:{version:1,workerId:'worker',pid:workerPid,storePath:store,...gate.snapshot()},
 db:async()=>({worker_id:'worker',deployment_id:'test',base_url:url,project_ids:Object.keys(loadedScope),draining:false,reservations:0,services:0,heartbeat_at:beatTime,observed_at:Date.now(),active:f.db().identities.filter((i:any)=>!i.revoked_at),identities:f.db().identities}),},
 systemctl:async args=>{if(args[0]==='show')return `FragmentPath=${args[1]===workerUnit?workerFragment:heartbeatFragment}\nDropInPaths=\nLoadState=loaded\nNeedDaemonReload=no\nKillMode=process\nSendSIGKILL=no\nTimeoutStopUSec=infinity\n`;
 if(args[0]==='restart'){await new Promise(r=>setTimeout(r,12));workerPid=workerPid===process.pid?process.pid+1:process.pid;beatPid++;started=Date.now();beatTime=started;loadedScope=JSON.parse(read(c.configFile,'utf8')).projects;loadedJti=verifyWorkbenchWorkerIdentity(read(c.identityFile,'utf8').trim())!.jti;}
 return '';}};
 return {...f,c,cfg,ports,server,loseCommit:()=>{loseCommit=true;},failUpload:()=>{failUpload=true;},gate};
}

describe('CLI entry → real adapters → HTTP/child probe → SQL boundary',()=>{
 it('activates with official DB/lifecycle/heartbeat/observer/probe composition',async()=>{
  const f=await acceptance();const result=await runScopeCli(['--policy',f.cfg,'--apply'],f.ports);expect(result).toEqual({status:'active',projectId:'new'});
  expect(f.db().desire.status).toBe('active');expect(JSON.parse(fs.readFileSync(f.input.stateFile,'utf8')).owner).toBeNull();
 });
 it('actual observer rollback captures loaded forward evidence before config restoration',async()=>{
  const f=await acceptance();f.failUpload();expect(await runScopeCli(['--policy',f.cfg,'--apply'],f.ports)).toMatchObject({status:'blocked'});
  expect(JSON.parse(fs.readFileSync(f.input.stateFile,'utf8')).operation.phase).toBe('probe-intent');
  expect(await runScopeCli(['--policy',f.cfg,'--recover'],f.ports)).toMatchObject({status:'recovered'});
  expect(f.db().desire.status).toBe('failed');expect(JSON.parse(fs.readFileSync(f.c.configFile,'utf8')).projects).toEqual(f.op.oldScope);
 });
 it('real probe receipt at binding-committed is read-only recoverable without replay',async()=>{
  const f=await acceptance();expect(await runScopeCli(['--policy',f.cfg,'--apply'],f.ports)).toMatchObject({status:'active'});
  const state=JSON.parse(fs.readFileSync(f.input.stateFile,'utf8'));state.owner=state.completedOwner;state.operation=state.completedOperation;state.phase='binding-committed';delete state.completedOwner;delete state.completedOperation;
  fs.writeFileSync(f.input.stateFile,JSON.stringify(state));
  expect(await runScopeCli(['--policy',f.cfg,'--recover'],f.ports)).toMatchObject({status:'recovered'});
 });
 it('read-only preflight neither claims nor writes SQL/journal/config',async()=>{
  const f=await acceptance();const before=fs.readFileSync(f.input.stateFile);const claim=vi.fn(f.ports.claim);f.ports.claim=claim;
  expect(await runScopeCli(['--policy',f.cfg,'--preflight'],f.ports)).toEqual({status:'ready',projectId:'new'});expect(claim).not.toHaveBeenCalled();expect(fs.readFileSync(f.input.stateFile)).toEqual(before);expect(f.sqls.every(v=>v.sql.trim().startsWith('SELECT'))).toBe(true);
 });
 it('missing root provisioning is blocked without claim',async()=>{
  const f=await acceptance();f.ports.inspect=async()=>{throw Error('SCOPE_INSTALL_DIRECTORY_UNTRUSTED');};const claim=vi.fn(f.ports.claim);f.ports.claim=claim;
  expect(await runScopeCli(['--policy',f.cfg,'--apply'],f.ports)).toMatchObject({status:'blocked'});expect(claim).not.toHaveBeenCalled();
 });
 it('real probe + DB commit reply loss recovers by read-only persisted receipt without nonce replay',async()=>{
  const f=await acceptance();f.loseCommit();expect(await runScopeCli(['--policy',f.cfg,'--apply'],f.ports)).toMatchObject({status:'blocked'});
  expect(f.db().desire.status).toBe('active');expect(JSON.parse(fs.readFileSync(f.input.stateFile,'utf8')).operation.phase).toBe('binding-intent');
  expect(await runScopeCli(['--policy',f.cfg,'--recover'],f.ports)).toMatchObject({status:'recovered'});expect(f.gate.snapshot()).toEqual({draining:false,activeRequests:0});
 });
});

describe('real process CLI entry',()=>{
 it('actual argv invocation is read-only and blocks unprovisioned policy without DB/systemctl',()=>{
   const result=spawnSync(process.execPath,['--import','tsx','packages/backend/scripts/worker-scope-cli.ts','--policy','/nonexistent/scope-policy.json','--preflight'],{
     cwd:process.cwd(),env:{PATH:process.env.PATH,HOME:process.env.HOME},encoding:'utf8',timeout:10000});
   expect(result.status).toBe(1);expect(JSON.parse(result.stdout.trim())).toMatchObject({status:'blocked'});
 });
});

describe('routing and pure installation renderers',()=>{
 it('plans a per-worker real fragment without changing bytes or broad write access',()=>{
  const unit='tower-workbench-worker-example-heartbeat.service';
  const source='[Unit]\nDescription=heartbeat\n[Service]\nExecStart=/nix/store/example/bin/heartbeat\n';
  const plan=planScopeHeartbeatRelocation('example','/etc/systemd/system/'+unit,source);
  expect(plan.target).toBe('/etc/tower-worker-scope-units/example/'+unit);
  expect(plan.content).toBe(source);expect(plan.sha256).toBe(digest(source));expect(plan.changed).toBe(true);
  expect(planScopeHeartbeatRelocation('example',plan.target,source).changed).toBe(false);
  expect(()=>planScopeHeartbeatRelocation('../escape',plan.link,source)).toThrow();
  expect(()=>planScopeHeartbeatRelocation('example','/other/'+unit,source)).toThrow();
  expect(()=>planScopeHeartbeatRelocation('example',plan.link,source+'WorkingDirectory=%Y\n')).toThrow('COMPLEX');
 });

 it.each([false,true])('prepared scope remains no-mutation with enrolled=%s',enrolled=>{
  expect(chooseScopeAssignmentRoute({signed:false,projectId:'p',root:'/project',projects:{p:'/project'},enrolled})).toBe('legacy-no-mutation');
 });
 it('signed grants never substitute for static file scope',()=>{
  expect(chooseScopeAssignmentRoute({signed:true,projectId:'p',root:'/project',projects:{},enrolled:true})).toBe('dedicated-scope');
  expect(chooseScopeAssignmentRoute({signed:true,projectId:'p',root:'/project',projects:{},enrolled:false})).toBe('blocked');
  expect(chooseScopeAssignmentRoute({signed:false,projectId:'p',root:'/project',projects:{},enrolled:true})).toBe('dedicated-scope');
  expect(chooseScopeAssignmentRoute({signed:false,projectId:'p',root:'/project',projects:{},enrolled:false})).toBe('blocked');
 });
 it('unit renders immutable entry and narrow dirs; broad system unit parent is rejected',async()=>{
  const f=await acceptance();const c={...f.c,projectsRoot:'/srv/customer/projects',backupDirectory:path.join(f.root,'backup'),stagingDirectory:path.join(f.root,'backup/stage')};
  const unit=renderScopeCoordinatorUnit(c,f.cfg);expect(unit).toContain('--preflight');expect(unit).toContain(c.nodeBinary);expect(unit).not.toContain('flock');expect(unit).not.toContain('ReadWritePaths=/etc/systemd/system');
  expect(()=>validateScopeInstallationPolicy({...c,heartbeatFragment:'/etc/systemd/system/'+c.heartbeatUnit})).toThrow('TOO_BROAD');
 });
});

// Regressions from independent review, through the same composed CLI fixture.
describe('claim-intent ordering and coordinator secret policy',()=>{
 it('unsupported heartbeat EnvironmentFile blocks preflight and apply before claim/fence',async()=>{
  const f=await acceptance();fs.appendFileSync(f.c.heartbeatFragment,'EnvironmentFile=/nonexistent/review-only\n');
  const claim=vi.fn(f.ports.claim);f.ports.claim=claim;const before=fs.readFileSync(f.c.stateFile);
  for(const mode of ['--preflight','--apply'])expect(await runScopeCli(['--policy',f.cfg,mode],f.ports)).toMatchObject({status:'blocked',reason:'HEARTBEAT_ENVIRONMENT_PRECEDENCE_CONFLICT'});
  expect(claim).not.toHaveBeenCalled();expect(fs.readFileSync(f.c.stateFile)).toEqual(before);expect(f.db().desire.status).toBe('pending');
 });
 it('missing flock is an execution failure, not busy; no claim or journal',async()=>{
  const f=await acceptance();const claim=vi.fn(f.ports.claim);f.ports.claim=claim;const old=process.env.PATH;
  try{process.env.PATH='/nonexistent/review-only';
   expect(await runScopeCli(['--policy',f.cfg,'--apply'],f.ports)).toMatchObject({status:'blocked',reason:'SCOPE_LOCK_EXECUTION_FAILED'});
  }finally{process.env.PATH=old;}
  expect(claim).not.toHaveBeenCalled();expect(JSON.parse(fs.readFileSync(f.c.stateFile,'utf8')).owner).toBeNull();expect(f.db().desire.status).toBe('pending');
 });
 it('actual EX contention prevents claim without producing preparing',async()=>{
  const f=await acceptance();const claim=vi.fn(f.ports.claim);f.ports.claim=claim;
  const unlock=acquireScopeMutationLock(f.c.lockFile);
  try{expect(await runScopeCli(['--policy',f.cfg,'--apply'],f.ports)).toMatchObject({status:'blocked',reason:'SCOPE_DEPLOYMENT_LOCK_BUSY'});}finally{unlock();}
  expect(claim).not.toHaveBeenCalled();expect(f.db().desire.status).toBe('pending');expect(JSON.parse(fs.readFileSync(f.c.stateFile,'utf8')).owner).toBeNull();
 });
 it('flock disappears after tool preflight but before EX: still no claim/journal',async()=>{
  const f=await acceptance(),old=process.env.PATH;const claim=vi.fn(f.ports.claim);f.ports.claim=claim;const observer=f.ports.observer!.project!;let checks=0;
  f.ports.observer!.project=async value=>{const ok=await observer(value);if(++checks===2)process.env.PATH='/nonexistent/review-only';return ok;};
  try{expect(await runScopeCli(['--policy',f.cfg,'--apply'],f.ports)).toMatchObject({status:'blocked',reason:'SCOPE_LOCK_EXECUTION_FAILED'});}finally{process.env.PATH=old;}
  expect(claim).not.toHaveBeenCalled();expect(JSON.parse(fs.readFileSync(f.c.stateFile,'utf8')).owner).toBeNull();expect(f.db().desire.status).toBe('pending');
 });
 it('missing flock at actual acquisition is not disguised as contention',async()=>{
  const f=await acceptance(),old=process.env.PATH;try{process.env.PATH='/nonexistent';expect(()=>acquireScopeMutationLock(f.c.lockFile)).toThrow('SCOPE_LOCK_EXECUTION_FAILED');}finally{process.env.PATH=old;}
 });
 it('invalid installed identity fails before claim',async()=>{
  const f=await acceptance();fs.writeFileSync(f.c.identityFile,'synthetic-invalid-jwt');const claim=vi.fn(f.ports.claim);f.ports.claim=claim;
  expect(await runScopeCli(['--policy',f.cfg,'--apply'],f.ports)).toMatchObject({status:'blocked'});expect(claim).not.toHaveBeenCalled();expect(f.db().desire.status).toBe('pending');
 });
 it('backup failure before owner journal never claims',async()=>{
  const f=await acceptance();const claim=vi.fn(f.ports.claim);f.ports.claim=claim;const mkdir=fs.mkdirSync.bind(fs);
  vi.spyOn(fs,'mkdirSync').mockImplementation(((p:any,...args:any[])=>{if(String(p).startsWith(f.root+'/'))throw Error('fixture disk full');return mkdir(p,...args as []);}) as any);
  expect(await runScopeCli(['--policy',f.cfg,'--apply'],f.ports)).toMatchObject({status:'blocked'});expect(claim).not.toHaveBeenCalled();expect(JSON.parse(fs.readFileSync(f.c.stateFile,'utf8')).owner).toBeNull();
 });
 it('journal write failure before claim never produces preparing',async()=>{
  const f=await acceptance();const claim=vi.fn(f.ports.claim);f.ports.claim=claim;const rename=fs.renameSync.bind(fs);
  vi.spyOn(fs,'renameSync').mockImplementation((a,b)=>{if(b===f.c.stateFile)throw Error('fixture journal rename failure');return rename(a,b);});
  expect(await runScopeCli(['--policy',f.cfg,'--apply'],f.ports)).toMatchObject({status:'blocked'});expect(claim).not.toHaveBeenCalled();expect(f.db().desire.status).toBe('pending');
 });
 it('claim committed but reply lost has exact durable intent and recovers without rotation',async()=>{
  const f=await acceptance();const claim=f.ports.claim!;f.ports.claim=async(c,row)=>{await claim(c,row);throw Error('fixture claim reply lost');};
  const identity=fs.readFileSync(f.c.identityFile),config=fs.readFileSync(f.c.configFile);
  expect(await runScopeCli(['--policy',f.cfg,'--apply'],f.ports)).toMatchObject({status:'blocked'});
  const journal=JSON.parse(fs.readFileSync(f.c.stateFile,'utf8'));expect(journal.operation.phase).toBe('claim-intent');expect(journal.operation.leaseOwner).toBe(f.db().desire.lease_owner);
  expect(await runScopeCli(['--policy',f.cfg,'--recover'],f.ports)).toMatchObject({status:'recovered'});
  expect(f.db().desire.status).toBe('failed');expect(fs.readFileSync(f.c.identityFile)).toEqual(identity);expect(fs.readFileSync(f.c.configFile)).toEqual(config);expect(f.db().identities).toHaveLength(1);
 });
 it('default exact-candidate SQL claim ignores older excluded rows and activates the verified Project',async()=>{
  const f=await acceptance();delete f.ports.claim;delete f.ports.resolveClaim;
  f.db().excluded=[{project_id:'older-system',root_path:f.root+'/system',status:'pending',system_key:'system'}, {project_id:'older-archived',root_path:f.root+'/archived',status:'pending',archived:1}];
  expect(await runScopeCli(['--policy',f.cfg,'--apply'],f.ports)).toMatchObject({status:'active'});
  const selection=f.sqls.find(v=>v.sql.includes('FOR UPDATE OF d,p'))!;
  expect(f.db().excluded.every((r:any)=>r.status==='pending'&&!r.lease_owner)).toBe(true);
  expect(selection.values).toEqual([f.c.deploymentId,f.c.workerId,'new',f.input.root]);
  expect(selection.sql).toContain('COALESCE(p.archived,0)=0');expect(selection.sql).toContain("COALESCE(p.lifecycle_status,'active')='active'");expect(selection.sql).toContain('p.system_key');
  expect(f.sqls.filter(v=>v.sql.includes("SET status='preparing',attempt=attempt+1"))).toHaveLength(1);
 });
 it('default SQL claim reply loss resolves exact lease under the same advisory lock',async()=>{
  const f=await acceptance();delete f.ports.claim;delete f.ports.resolveClaim;
  const original=vi.mocked(transaction).getMockImplementation()!;let lost=false;
  vi.mocked(transaction).mockImplementation((async(fn:any)=>{const value=await original(fn);if(!lost&&f.db().desire.status==='preparing'){lost=true;throw Error('claim commit reply lost');}return value;}) as any);
  expect(await runScopeCli(['--policy',f.cfg,'--apply'],f.ports)).toMatchObject({status:'blocked'});
  expect(JSON.parse(fs.readFileSync(f.c.stateFile,'utf8')).operation.phase).toBe('claim-intent');
  expect(await runScopeCli(['--policy',f.cfg,'--recover'],f.ports)).toMatchObject({status:'recovered'});
  expect(f.db().desire.status).toBe('failed');expect(f.sqls.some(v=>v.sql.includes(' AS bound')&&v.transaction)).toBe(true);
 });
 it('unclaimed or ambiguous intent is retained, never reset based on absent reply',async()=>{
  const f=await acceptance();f.ports.claim=async()=>undefined;
  expect(await runScopeCli(['--policy',f.cfg,'--apply'],f.ports)).toMatchObject({status:'blocked',reason:'SCOPE_CLAIM_NOT_ACQUIRED'});
  const before=fs.readFileSync(f.c.stateFile);expect(await runScopeCli(['--policy',f.cfg,'--recover'],f.ports)).toMatchObject({status:'blocked',reason:'SCOPE_CLAIM_NOT_ACQUIRED_REVIEW_REQUIRED'});
  expect(fs.readFileSync(f.c.stateFile)).toEqual(before);expect(f.db().desire.status).toBe('pending');
 });
 it('foreign lease is not released or changed during claim-intent recovery',async()=>{
  const f=await acceptance();const claim=f.ports.claim!;f.ports.claim=async(c,row)=>{await claim(c,row);throw Error('reply loss');};
  await runScopeCli(['--policy',f.cfg,'--apply'],f.ports);f.db().desire.lease_owner='unrelated-owner';
  const before=fs.readFileSync(f.c.stateFile);expect(await runScopeCli(['--policy',f.cfg,'--recover'],f.ports)).toMatchObject({status:'blocked',reason:'SCOPE_CLAIM_AMBIGUOUS'});
  expect(f.db().desire.lease_owner).toBe('unrelated-owner');expect(fs.readFileSync(f.c.stateFile)).toEqual(before);
 });
 it.each([0o640,0o644,0o660])('rejects coordinator environment mode %s without reading secrets',async mode=>{
  const f=await acceptance();fs.writeFileSync(f.c.environmentFile,'synthetic empty fixture',{mode});
  expect(()=>assertScopeCoordinatorEnvironment(f.c.environmentFile)).toThrow('SCOPE_INSTALL_');
  const claim=vi.fn(f.ports.claim);f.ports.claim=claim;const inspect=f.ports.inspect!;
  f.ports.inspect=async(...args)=>{assertScopeCoordinatorEnvironment(f.c.environmentFile);return inspect(...args);};
  expect(await runScopeCli(['--policy',f.cfg,'--apply'],f.ports)).toMatchObject({status:'blocked'});expect(claim).not.toHaveBeenCalled();
 });
 it('root:root 0600 coordinator environment is accepted separately from installed identity 0640',async()=>{
  const f=await acceptance();fs.writeFileSync(f.c.environmentFile,'synthetic empty fixture',{mode:0o600});const lstat=vi.mocked(fs.lstatSync).getMockImplementation()!;
  vi.spyOn(fs,'lstatSync').mockImplementation(((p:any,...args:any[])=>{const st=lstat(p,...args as []);if(p===f.c.environmentFile)st.gid=0;return st;}) as any);
  expect(()=>assertScopeCoordinatorEnvironment(f.c.environmentFile)).not.toThrow();expect(fs.statSync(f.c.identityFile).mode&0o777).toBe(0o640);
 });
});
