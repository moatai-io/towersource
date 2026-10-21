#!/usr/bin/env node
/** Provisioning-only first Worker verification. Credentials resolved by product APIs, never argv/logs. */
import {createRemoteWorkbenchHttpTransport} from '../services/execution/worker/worker-http-transport.js';
import {getPersistedWorkbenchWorker} from '../services/execution/worker/worker-repository.js';
import {resolveWorkbenchWorkerTransportToken} from '../services/execution/worker/worker-transport-credentials.js';
import {activateProjectWorkerFirst} from '../services/runtime-box/workbench-project-worker-first-activation.js';
import {closePgPool} from '../db/pg.js';
import {query} from '../db/pg-repo.js';
import {randomUUID} from 'node:crypto';
async function main(){
 const projectId=process.env.TOWER_PROVISIONING_PROJECT_ID,workerId='tower-provision-local-01',actorUserId=Number(process.env.TOWER_PROVISIONING_ACTOR_USER_ID);
 if(!projectId||!Number.isSafeInteger(actorUserId)||actorUserId<1)throw Error('provisioning_worker_input_invalid');
 const project=await query<{root_path:string}>('select root_path from projects where id=$1 and archived=0',[projectId]);
 if(project.length!==1||!project[0].root_path.startsWith('/var/lib/tower/runtime/workspace/projects/'))throw Error('provisioning_worker_project_invalid');
 const bound=await query('select project_id from project_compute_deployment_bindings where project_id=$1',[projectId]);if(bound.length)throw Error('provisioning_worker_existing_binding');
 let worker=await getPersistedWorkbenchWorker(workerId);
 for(let n=0;n<60&&(!worker||worker.status!=='healthy');n++){await new Promise(r=>setTimeout(r,500));worker=await getPersistedWorkbenchWorker(workerId);}
 if(!worker||worker.status!=='healthy'||worker.baseUrl!=='http://127.0.0.1:43325'||!worker.projectIds.includes(projectId))throw Error('provisioning_worker_scope_unverified');
 const token=await resolveWorkbenchWorkerTransportToken(workerId,actorUserId);if(!token)throw Error('provisioning_worker_auth_unavailable');
 const transport=createRemoteWorkbenchHttpTransport({workerId,baseUrl:worker.baseUrl,token,projectRoot:project[0].root_path});
 const filename='.tower-provision-smoke-'+randomUUID()+'.txt',nonce=randomUUID();let stdout='';
 const command=['set -e','(test "$(pwd)" = /workspace || test "$(pwd)" = '+JSON.stringify(project[0].root_path)+')',`printf %s ${JSON.stringify(nonce)} > ${JSON.stringify(filename)}`,`test "$(cat ${JSON.stringify(filename)})" = ${JSON.stringify(nonce)}`,`rm -- ${JSON.stringify(filename)}`,`test ! -e ${JSON.stringify(filename)}`,'printf provisioning-worker-roundtrip-ok'].join(' && ');
 const result=await transport.execute({spec:{jobId:990000000+Math.floor(Math.random()*1000000),projectId,actorUserId,command,cwd:'/workspace',timeoutSec:30,workbenchRevision:null,environmentKeys:[],artifacts:[]},signal:AbortSignal.timeout(35000),onStdout:s=>{stdout+=s;},onStderr:()=>{}});
 if(result.execResult.exit_code!==0||!stdout.includes('provisioning-worker-roundtrip-ok'))throw Error('provisioning_worker_smoke_failed');
 await activateProjectWorkerFirst({projectId,deploymentId:'production',workerId,authorityMode:'project',actorUserId,requireUnbound:true,rolloutCohort:'provisioning-first-customer',reason:'authenticated worker file roundtrip verified',fileAuthorityReady:true,verificationEvidence:'worker-file-roundtrip'});
 console.log(JSON.stringify({workerVerified:true,fileAuthorityVerified:true,activated:true,customerReady:false}));
}
main().catch(()=>{console.error('provisioning Worker verification failed; preserve intent and reconcile');process.exitCode=1;}).finally(closePgPool);
