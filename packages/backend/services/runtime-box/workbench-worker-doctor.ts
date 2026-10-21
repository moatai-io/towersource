/**
 * Owns: read-only operational diagnosis for one persisted Workbench Worker.
 * Public API: diagnoseWorkbenchWorker and summarizeWorkbenchWorkerDiagnosis.
 * Does not resolve or expose secret values and never mutates Worker state.
 */
import { listWorkbenchJobs } from '../execution/jobs/job-registry.js';
import { listWorkbenchWorkerIdentities } from './workbench-worker-identity-repository.js';
import { getPersistedWorkbenchWorker } from '../execution/worker/worker-repository.js';
import { getWorkbenchWorkerTransportCredentialBinding } from '../execution/worker/worker-transport-credentials.js';

export type WorkerDoctorOverall='HEALTHY'|'DEGRADED'|'OFFLINE';
export interface WorkerDoctorCheck { name:string; ok:boolean; detail:string; fix?:string }
export interface WorkerDoctorReport { workerId:string; overall:WorkerDoctorOverall; checks:WorkerDoctorCheck[]; worker:Awaited<ReturnType<typeof getPersistedWorkbenchWorker>>; recentJobs:Awaited<ReturnType<typeof listWorkbenchJobs>> }
export interface WorkerDoctorDeps {
  getWorker:typeof getPersistedWorkbenchWorker;
  listIdentities:typeof listWorkbenchWorkerIdentities;
  getBinding:typeof getWorkbenchWorkerTransportCredentialBinding;
  listJobs:typeof listWorkbenchJobs;
  probe:(url:string)=>Promise<boolean>;
}
const defaults:WorkerDoctorDeps={
  getWorker:getPersistedWorkbenchWorker,listIdentities:listWorkbenchWorkerIdentities,getBinding:getWorkbenchWorkerTransportCredentialBinding,listJobs:listWorkbenchJobs,
  probe:async url=>{try{const r=await fetch(`${url}/health`,{signal:AbortSignal.timeout(3000)});return r.ok}catch{return false}},
};
/** Diagnose one Worker from persisted metadata, non-secret authority metadata, and its health endpoint. */
export async function diagnoseWorkbenchWorker(workerId:string,deps:WorkerDoctorDeps=defaults):Promise<WorkerDoctorReport>{
 const worker=await deps.getWorker(workerId);const checks:WorkerDoctorCheck[]=[];
 if(!worker)return{workerId,overall:'OFFLINE',checks:[{name:'registry',ok:false,detail:'Worker registry row not found',fix:'register the Worker with an active signed identity'}],worker,recentJobs:[]};
 checks.push({name:'registry',ok:true,detail:`${worker.status}; heartbeat=${worker.heartbeatAt}`});
 checks.push({name:'heartbeat',ok:worker.status==='healthy',detail:worker.status==='healthy'?'heartbeat is fresh':`heartbeat is ${worker.status}`,fix:'restart the Worker heartbeat component'});
 checks.push({name:'drain',ok:!worker.draining,detail:worker.draining?'Worker is draining':'Worker accepts work',fix:'undrain only after operator review'});
 checks.push({name:'capability',ok:worker.capabilities.includes('job'),detail:`capabilities=${worker.capabilities.join(',')||'none'}`,fix:'register capability job'});
 checks.push({name:'scope',ok:worker.projectIds.length>0,detail:`projects=${worker.projectIds.length}`,fix:'register an explicit Project allowlist'});
 const identities=await deps.listIdentities(workerId,20);const now=Date.now();const active=identities.find(x=>!x.revoked_at&&Date.parse(x.expires_at)>now);
 checks.push({name:'identity',ok:Boolean(active),detail:active?`active jti=${active.jti}`:'no active identity',fix:'issue and record a replacement Worker identity'});
 const binding=await deps.getBinding(workerId);checks.push({name:'transport',ok:Boolean(binding),detail:binding?`binding=${binding.secret_name}`:'transport credential binding missing',fix:'configure the Worker-specific transport credential'});
 const reachable=await deps.probe(worker.baseUrl);checks.push({name:'endpoint',ok:reachable,detail:`${worker.baseUrl} ${reachable?'reachable':'unreachable'}`,fix:'check the Worker process and Tower tunnel'});
 const jobs=(await Promise.all(worker.projectIds.map(p=>deps.listJobs(p,10)))).flat().filter(j=>j.runner_id===`remote:${workerId}`||j.provider_kind==='remote-worker').sort((a,b)=>Number(b.id)-Number(a.id)).slice(0,10);
 const hardOffline=worker.status==='stale'&&!reachable;const degraded=checks.some(c=>!c.ok);
 return{workerId,overall:hardOffline?'OFFLINE':degraded?'DEGRADED':'HEALTHY',checks,worker,recentJobs:jobs};
}
/** Render a terse operator-oriented report with fixes before low-level details. */
export function summarizeWorkbenchWorkerDiagnosis(report:WorkerDoctorReport):string{
 const lines=[`Worker: ${report.workerId}`,`Overall: ${report.overall}`,''];
 for(const c of report.checks)lines.push(`${c.ok?'✅':'❌'} ${c.name}: ${c.detail}${!c.ok&&c.fix?`\n   Fix: ${c.fix}`:''}`);
 if(report.recentJobs.length){lines.push('','Recent remote jobs:');for(const j of report.recentJobs.slice(0,5))lines.push(`- job:${j.id} ${j.status} ${j.error_code??''}`.trim())}
 return lines.join('\n');
}
