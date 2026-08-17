import {describe,expect,it} from 'vitest';
import {diagnoseWorkbenchWorker} from './workbench-worker-doctor.js';
const worker={workerId:'w1',baseUrl:'http://127.0.0.1:9',capabilities:['job'],projectIds:['p1'],capacity:{cpuTotal:2,memoryMbTotal:2048,activeRuns:0,maxRuns:1},draining:false,registeredAt:new Date().toISOString(),heartbeatAt:new Date().toISOString(),status:'healthy' as const};
const identity={jti:'j1',worker_id:'w1',project_ids:['p1'],capabilities:['job'],issued_by_user_id:1,issued_at:new Date().toISOString(),expires_at:new Date(Date.now()+60_000).toISOString(),revoked_at:null,replaced_by_jti:null,reason:null};
const deps=(overrides:any={})=>({getWorker:async()=>worker,listIdentities:async()=>[identity],getBinding:async()=>({worker_id:'w1',secret_name:'SECRET_REF',configured_by_user_id:1,configured_at:new Date(),updated_at:new Date()}),listJobs:async()=>[],probe:async()=>true,...overrides});
describe('Workbench Worker doctor',()=>{
 it('reports healthy only when operational and authority checks pass',async()=>expect((await diagnoseWorkbenchWorker('w1',deps())).overall).toBe('HEALTHY'));
 it('reports degraded for a missing transport binding',async()=>{const r=await diagnoseWorkbenchWorker('w1',deps({getBinding:async()=>undefined}));expect(r.overall).toBe('DEGRADED');expect(r.checks.find(x=>x.name==='transport')?.ok).toBe(false)});
 it('reports offline when registry is absent or stale endpoint is unreachable',async()=>{expect((await diagnoseWorkbenchWorker('w1',deps({getWorker:async()=>undefined}))).overall).toBe('OFFLINE');expect((await diagnoseWorkbenchWorker('w1',deps({getWorker:async()=>({...worker,status:'stale'}),probe:async()=>false}))).overall).toBe('OFFLINE')});
});
