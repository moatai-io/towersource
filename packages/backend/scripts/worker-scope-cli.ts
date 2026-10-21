#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { queryOne, transaction, withClient } from '../db/pg-repo.js';
import { closePgPool } from '../db/pg.js';
import { createWorkerScopeAssignmentDbAdapter } from './worker-scope-assignment-db-adapter.js';
import { createWorkerScopeRuntimeObserver, scopeLockHeld } from './worker-scope-runtime-observer.js';
import { createWorkerScopeHeartbeatAdapter, type SystemctlRunner } from './worker-scope-heartbeat-adapter.js';
import { WorkerScopeAssignmentLifecycle, scopeDigest, digest, type AssignmentInput, type ScopeLifecycleAdapters } from './worker-scope-assignment-lifecycle.js';
import { assertScopeBackendListener, verifyPersistedScopeProbe, createScopeProjectExecutionClient } from '../services/runtime-box/worker-scope-execution-probe.js';
import { inspectScopeInstallation, loadScopeInstallationPolicy, preflightScopeTools, type ScopeInstallationPolicy } from './worker-scope-installation.js';

interface Candidate {project_id:string;root_path:string;lease_owner:string|null;status:string;}
export interface ScopeCliResult {status:'idle'|'ready'|'legacy-no-mutation'|'active'|'deferred'|'recovered'|'blocked';reason?:string;projectId?:string;}
/** Only tests/embedders supply these ports; CLI never loads an adapter module,
 * command, root, Project or credential path from flags/environment. */
export interface ScopeCliPorts {
  diagnostic?:(error:unknown)=>void;
  loadPolicy?:typeof loadScopeInstallationPolicy;
  inspect?:typeof inspectScopeInstallation;
  candidate?:(c:ScopeInstallationPolicy)=>Promise<Candidate|undefined>;
  claim?:(c:ScopeInstallationPolicy,expected:Candidate)=>Promise<Candidate|undefined>;
  resolveClaim?:(c:ScopeInstallationPolicy,expected:Candidate)=>Promise<'owned'|'unclaimed'|'ambiguous'>;
  tokens?:()=>{worker:string;backend:string};
  observer?:Parameters<typeof createWorkerScopeRuntimeObserver>[0]['ports'];
  systemctl?:SystemctlRunner;
  peer?: (value:{pid:number;uid:number;gid:number;startTicks:string})=>Promise<void>;
  dbOptions?:Partial<Pick<Parameters<typeof createWorkerScopeAssignmentDbAdapter>[0],'installedIdentity'>>;
  trustedState?:(file:string)=>void;
}
function tokens(){
  const worker=process.env.TOWER_REMOTE_WORKER_TOKEN,backend=process.env.TOWER_SCOPE_BACKEND_PROBE_TOKEN;
  if(!worker||!backend)throw new Error('SCOPE_CLI_AUTHENTICATION_NOT_PROVISIONED');
  return {worker,backend};
}
async function candidate(c:ScopeInstallationPolicy){return queryOne<Candidate>(`SELECT d.project_id,d.status,d.lease_owner,p.root_path
  FROM project_worker_assignment_desires d JOIN projects p ON p.id=d.project_id
  WHERE d.deployment_id=$1 AND d.desired_worker_id=$2 AND d.status='pending' AND d.lease_owner IS NULL
  AND COALESCE(p.archived,0)=0 AND COALESCE(p.lifecycle_status,'active')='active'
  AND NULLIF(BTRIM(COALESCE(p.system_key,'')),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM project_worker_assignment_desires busy WHERE busy.deployment_id=$1 AND busy.desired_worker_id=$2 AND busy.status IN ('preparing','recovery_required'))
  ORDER BY d.updated_at,d.project_id LIMIT 1`,[c.deploymentId,c.workerId]);}
/** Uses the same Worker advisory lock as the ordinary assignment claim, but
 * selects only the already validated candidate. No change to shared service. */
async function claim(c:ScopeInstallationPolicy,expected:Candidate){
  return transaction(async client=>{
    const db=withClient(client);
    const lock=await db.queryOne<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtext($1),hashtext($2)) AS locked',[`worker-assignment:${c.deploymentId}`,c.workerId]);
    if(!lock?.locked)return undefined;
    const journal=JSON.parse(fs.readFileSync(c.stateFile,'utf8'));
    if(!journal.owner || journal.owner!==journal.operation?.id || journal.operation.phase!=='claim-intent'
      || journal.operation.projectId!==expected.project_id || journal.operation.leaseOwner!==expected.lease_owner)throw new Error('SCOPE_CLAIM_INTENT_CHANGED');
    const row=await db.queryOne<Candidate>(`SELECT d.project_id,d.status,d.lease_owner,p.root_path
      FROM project_worker_assignment_desires d JOIN projects p ON p.id=d.project_id
      WHERE d.deployment_id=$1 AND d.desired_worker_id=$2 AND d.project_id=$3 AND p.root_path=$4 AND d.status='pending' AND d.lease_owner IS NULL
      AND COALESCE(p.archived,0)=0 AND COALESCE(p.lifecycle_status,'active')='active'
      AND NULLIF(BTRIM(COALESCE(p.system_key,'')),'') IS NULL
      AND NOT EXISTS(SELECT 1 FROM project_worker_assignment_desires busy WHERE busy.deployment_id=$1 AND busy.desired_worker_id=$2 AND busy.status IN ('preparing','recovery_required'))
      AND NOT EXISTS(SELECT 1 FROM project_compute_deployment_bindings b WHERE b.project_id=d.project_id AND b.deployment_id=d.deployment_id)
      FOR UPDATE OF d,p`,[c.deploymentId,c.workerId,expected.project_id,expected.root_path]);
    if(!row)return undefined;
    const claimed=await db.queryOne<Candidate>(`UPDATE project_worker_assignment_desires SET status='preparing',attempt=attempt+1,
      lease_owner=$2,lease_expires_at=NOW()+INTERVAL '600 seconds',last_error=NULL,updated_at=NOW()
      WHERE project_id=$1 AND deployment_id=$3 AND desired_worker_id=$4 AND status='pending' RETURNING *`,
      [row.project_id,expected.lease_owner,c.deploymentId,c.workerId]);
    return claimed?{...claimed,root_path:row.root_path}:undefined;
  });
}
async function resolveClaim(c:ScopeInstallationPolicy,expected:Candidate):Promise<'owned'|'unclaimed'|'ambiguous'>{
  return transaction(async client=>{
    const db=withClient(client);
    const lock=await db.queryOne<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtext($1),hashtext($2)) AS locked',[`worker-assignment:${c.deploymentId}`,c.workerId]);
    if(!lock?.locked)return 'ambiguous';
    const row=await db.queryOne<{status:string;lease_owner:string|null;desired_worker_id:string;bound:boolean}>(`SELECT d.status,d.lease_owner,d.desired_worker_id,
      EXISTS(SELECT 1 FROM project_compute_deployment_bindings b WHERE b.project_id=d.project_id AND b.deployment_id=d.deployment_id) AS bound
      FROM project_worker_assignment_desires d WHERE d.project_id=$1 AND d.deployment_id=$2 FOR UPDATE OF d`,[expected.project_id,c.deploymentId]);
    if(!row || row.bound || row.desired_worker_id!==c.workerId)return 'ambiguous';
    if(row.status==='preparing' && row.lease_owner===expected.lease_owner)return 'owned';
    return row.status==='pending' && row.lease_owner===null?'unclaimed':'ambiguous';
  });
}
function input(c:ScopeInstallationPolicy,row:Candidate):AssignmentInput {
  if(!row.root_path?.startsWith(c.projectsRoot+'/')||fs.realpathSync(row.root_path)!==row.root_path||!fs.statSync(row.root_path).isDirectory())throw new Error('SCOPE_CLI_PROJECT_ROOT_INVALID');
  return {projectId:row.project_id,root:row.root_path,leaseOwner:row.lease_owner??'preflight-unclaimed',workerId:c.workerId,deploymentId:c.deploymentId,
    configFile:c.configFile,identityFile:c.identityFile,stateFile:c.stateFile,lockFile:c.lockFile,backupDirectory:c.backupDirectory};
}
async function httpRead(url:string,token:string,method:'GET'|'POST'='GET',owner?:string):Promise<string>{
  const response=await fetch(url,{method,headers:{authorization:`Bearer ${token}`,...(owner?{'x-tower-maintenance-owner':owner}:{})},redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('SCOPE_CLI_HTTP_UNAVAILABLE');const reader=response.body?.getReader();if(!reader)throw new Error('SCOPE_CLI_RESPONSE_MISSING');
  let text='',size=0;try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>32768)throw new Error('SCOPE_CLI_RESPONSE_LIMIT');text+=Buffer.from(next.value).toString('utf8');}}finally{await reader.cancel();}return text;
}
/** All runtime methods have real production implementations. Injection is at
 * SQL/systemd/proc/test identity boundaries, never a production success fallback. */
export function composeScopeAssignment(c:ScopeInstallationPolicy,policyFile:string,value:AssignmentInput,ports:ScopeCliPorts={}):ScopeLifecycleAdapters {
  const auth=()=> (ports.tokens??tokens)();
  const policyHash=digest(fs.readFileSync(policyFile));
  const rawObserver=createWorkerScopeRuntimeObserver({policyFile,transportToken:async()=>auth().worker,ports:ports.observer});
  const observer={...rawObserver,authorize:async(value:AssignmentInput)=>{
    if(digest(fs.readFileSync(policyFile))!==policyHash)throw new Error('SCOPE_CLI_POLICY_CHANGED');
    await rawObserver.authorize(value);
  }};
  const db=createWorkerScopeAssignmentDbAdapter({input:value,actorUserId:c.actorUserId,stagingDirectory:c.stagingDirectory,fileAuthorityReady:true,
    installedIdentity:{uid:0,gid:c.executionGid,mode:0o640},...ports.dbOptions});
  const heartbeat=createWorkerScopeHeartbeatAdapter({trustedConfigFile:policyFile,runner:ports.systemctl,idle:observer.idle,
    authorize:async()=>{await observer.authorize(value);if(!scopeLockHeld(c.lockFile))throw new Error('SCOPE_CLI_EX_LOCK_REQUIRED');}});
  const dynamicProjects=new Proxy({} as Record<string,string>,{
    get:(_t,key)=>JSON.parse(fs.readFileSync(c.configFile,'utf8')).projects[key],
    ownKeys:()=>Object.keys(JSON.parse(fs.readFileSync(c.configFile,'utf8')).projects),getOwnPropertyDescriptor:()=>({enumerable:true,configurable:true}),
  });
  const projectExecutionProbe=createScopeProjectExecutionClient({stateFile:c.stateFile,workerId:c.workerId,projects:dynamicProjects,assertTrustedState:ports.trustedState,
    workerUrl:c.baseUrl,backendUrl:c.backendUrl,backendPolicyFile:c.backendPolicyFile,workerToken:async()=>auth().worker,backendToken:async()=>auth().backend,verifyBackendPeer:ports.peer});
  return {...db,...observer,...heartbeat,
    restart:async scope=>{
      await heartbeat.restart(scope);
      const op=JSON.parse(fs.readFileSync(c.stateFile,'utf8')).operation;
      const since=op.phase==='rollback-restart-intent'?op.rollbackStartedAt:op.switchStartedAt;
      const jti=op.phase==='rollback-restart-intent'?op.rollbackJti:op.newJti;
      const until=Date.now()+20000;
      while(Date.now()<until){
        try{const live=await observer.observe();if(live.identityJti===jti&&live.heartbeatIdentityJti===jti&&live.heartbeatAt>since
          &&live.heartbeatStartedAt>since&&scopeDigest(live.scope)===scopeDigest(scope))return;}catch{/* bounded startup observation only; lifecycle revalidates */}
        await new Promise(r=>setTimeout(r,250));
      }
      throw new Error('SCOPE_CLI_RESTART_READINESS_TIMEOUT');
    },
    maintenanceSmoke:async owner=>{
      const text=await httpRead(`${c.baseUrl}/v1/maintenance/smoke`,auth().worker,'POST',owner);
      const messages=text.trim().split('\n').map(l=>JSON.parse(l));const results=messages.filter(v=>v.type==='result');const r=results[0]?.result;
      if(results.length!==1||r?.execResult?.exit_code!==0||r.execResult.timed_out||r.execResult.stdout!=='MAINTENANCE_SMOKE_OK'||r.cancellation?.requested||r.cancellation?.processGroupExited!==true)throw new Error('SCOPE_CLI_MAINTENANCE_SMOKE_FAILED');
    },
    projectProbe:async owner=>JSON.parse(await httpRead(`${c.baseUrl}/v1/maintenance/project-probe`,auth().worker,'POST',owner)),
    projectExecutionProbe,verifyCommittedProbe:async op=>verifyPersistedScopeProbe({stateFile:c.stateFile,workerId:c.workerId,projects:op.newScope,assertTrustedState:ports.trustedState},op),
  };
}
/** Default mode is READ ONLY: no claim, EX/SH lock, staging, HTTP POST, journal
 * update, chmod, installer or systemctl mutation. Preflight may read DB and /proc. */
export async function runScopeCli(argv:string[],ports:ScopeCliPorts={}):Promise<ScopeCliResult>{
  let mode:'preflight'|'apply'|'recover'='preflight',policyFile='';
  try {
    if(argv.length<2||argv.length>3||argv[0]!=='--policy'||!path.isAbsolute(argv[1])||(argv[2]&&!['--preflight','--apply','--recover'].includes(argv[2])))throw new Error('SCOPE_CLI_ARGUMENTS_INVALID');
    policyFile=argv[1];if(argv[2])mode=argv[2].slice(2) as 'preflight'|'apply'|'recover';
    const c=(ports.loadPolicy??loadScopeInstallationPolicy)(policyFile);const baseline=digest(fs.readFileSync(policyFile));
    const state=JSON.parse(fs.readFileSync(c.stateFile,'utf8'));
    if(state.owner&&mode!=='recover')throw new Error('SCOPE_CLI_RECOVERY_REQUIRED');
    let row:Candidate|undefined;
    if(mode==='recover') {
      const op=state.operation??state.completedOperation;if(!op||op.workerId!==c.workerId||op.deploymentId!==c.deploymentId)throw new Error('SCOPE_CLI_RECOVERY_JOURNAL_REQUIRED');
      row={project_id:op.projectId,root_path:op.newScope[op.projectId],lease_owner:op.leaseOwner,status:'preparing'};
    }else row=await (ports.candidate??candidate)(c);
    if(!row)return {status:'idle'};
    const value=input(c,row);const config=JSON.parse(fs.readFileSync(c.configFile,'utf8'));
    if(mode!=='recover'&&Object.hasOwn(config.projects,row.project_id)){
      if(config.projects[row.project_id]!==row.root_path)throw new Error('SCOPE_CLI_EXISTING_ROOT_CONFLICT');
      // No system enrollment requirement is imposed on the legacy no-mutation
      // path. The legacy reconciler still verifies heartbeat/file readiness.
      return {status:'legacy-no-mutation',projectId:row.project_id};
    }
    await (ports.inspect??inspectScopeInstallation)(c,policyFile,{runner:ports.systemctl,trusted:ports.trustedState});
    const auth=(ports.tokens??tokens)();
    const worker=JSON.parse(await httpRead(`${c.baseUrl}/v1/maintenance/status`,auth.worker));
    if(worker.version!==1||worker.workerId!==c.workerId||worker.scopeProbeProtocol!=='scope-execution-v1')throw new Error('SCOPE_CLI_WORKER_ROUTE_NOT_INSTALLED');
    const backend=JSON.parse(await httpRead(`${c.backendUrl}/v1/maintenance/backend-shared-write/status`,auth.backend));
    if(backend.version!==1||backend.workerId!==c.workerId||backend.protocol!=='scope-shared-write-v1')throw new Error('SCOPE_CLI_BACKEND_ROUTE_NOT_INSTALLED');
    if(ports.peer)await ports.peer(backend.backend);else assertScopeBackendListener(c.backendPolicyFile,c.backendUrl,backend.backend);
    // Observer project/lease check expects a preparing row. Preflight authorization
    // supplies ONLY the already selected active Project check, not mutation ports.
    const previewObserver=createWorkerScopeRuntimeObserver({policyFile,transportToken:async()=>auth.worker,ports:{...ports.observer,
      project:ports.observer?.project??(async i=>{
        const current=await queryOne<{root_path:string;status:string;lease_owner:string|null}>(`SELECT p.root_path,d.status,d.lease_owner FROM projects p
          JOIN project_worker_assignment_desires d ON d.project_id=p.id WHERE p.id=$1 AND d.deployment_id=$2 AND d.desired_worker_id=$3
          AND COALESCE(p.archived,0)=0 AND COALESCE(p.lifecycle_status,'active')='active' AND NULLIF(BTRIM(COALESCE(p.system_key,'')),'') IS NULL`,[i.projectId,i.deploymentId,i.workerId]);
        return !!current&&current.root_path===i.root&&(mode==='recover'?current.lease_owner===i.leaseOwner:current.status==='pending');
      })}});
    preflightScopeTools();
    await previewObserver.authorize(value);await previewObserver.observe();
    if(mode!=='recover') {
      const heartbeat=createWorkerScopeHeartbeatAdapter({trustedConfigFile:policyFile,runner:ports.systemctl,authorize:async()=>{},idle:async()=>false});
      await heartbeat.preflightHeartbeat(config.projects);
      const identity=createWorkerScopeAssignmentDbAdapter({input:value,actorUserId:c.actorUserId,stagingDirectory:c.stagingDirectory,fileAuthorityReady:true,
        installedIdentity:{uid:0,gid:c.executionGid,mode:0o640},...ports.dbOptions});
      const link=await identity.readIdentity(),installed=await identity.publishedIdentity();
      if(link.activeJti!==installed.jti || link.projectIds.slice().sort().join(',')!==Object.keys(config.projects).sort().join(','))throw new Error('SCOPE_PREFLIGHT_IDENTITY_DRIFT');
    }
    if(digest(fs.readFileSync(policyFile))!==baseline)throw new Error('SCOPE_CLI_POLICY_CHANGED');
    if(mode==='preflight')return {status:'ready',projectId:row.project_id};
    if(mode==='apply') row={...row,lease_owner:`scope:${randomUUID()}`};
    if(digest(fs.readFileSync(policyFile))!==baseline)throw new Error('SCOPE_CLI_POLICY_CHANGED');
    const actual=input(c,row);
    const compositionPorts=mode==='apply'?{...ports,observer:{...ports.observer,project:async(i:AssignmentInput)=>{
      await previewObserver.authorize(i);return true; // exact pending Project check, not a free grant
    }}}:ports;
    const adapters=composeScopeAssignment(c,policyFile,actual,compositionPorts);
    const lifecycle=new WorkerScopeAssignmentLifecycle(actual,adapters);
    const result=mode==='recover'?await lifecycle.recover(()=> (ports.resolveClaim??resolveClaim)(c,row!)):
      await lifecycle.assign({acquire:async()=>{
        // Same heartbeat parser is rerun under EX and durable claim-intent,
        // still before any DB claim or Worker identity/config mutation.
        const heartbeat=createWorkerScopeHeartbeatAdapter({trustedConfigFile:policyFile,runner:ports.systemctl,authorize:async()=>{},idle:async()=>false});
        await heartbeat.preflightHeartbeat(config.projects);
        const claimed=await (ports.claim??claim)(c,row!);
        if(!claimed)return false;
        if(claimed.project_id!==row!.project_id || claimed.root_path!==row!.root_path || claimed.lease_owner!==row!.lease_owner)throw new Error('SCOPE_CLI_CANDIDATE_CHANGED_AFTER_CLAIM');
        return true;
      }});
    return {status:result==='assigned'?'active':result==='deferred'?'deferred':'recovered',projectId:row.project_id};
  }catch(error){
    ports.diagnostic?.(error);
    // Do not print provider details, paths or token-containing HTTP errors. A lost
    // reply after claim/mutation remains preparing/owned for explicit recovery.
    const message=error instanceof Error?error.message:'';
    return {status:'blocked',reason:/^(SCOPE|HEARTBEAT)_[A-Z_]+$/.test(message)?message:'SCOPE_CLI_FAILED_CLOSED'};
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  void runScopeCli(process.argv.slice(2)).then(r=>{console.log(JSON.stringify(r));process.exitCode=r.status==='blocked'?1:r.status==='legacy-no-mutation'?20:0;}).finally(()=>closePgPool());
}
