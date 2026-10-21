#!/usr/bin/env node
/** First provisioning Worker credential producer; existing Fleet/OSS producer is untouched.
 * Caller owns a durable bootstrap intent and protected stage. No identity rotation.
 */
import crypto from 'node:crypto';import fs from 'node:fs/promises';import {constants} from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {query} from '../db/pg-repo.js';import {closePgPool} from '../db/pg.js';
import {issueWorkbenchWorkerIdentity} from '../services/runtime-box/workbench-worker-identity.js';
import {recordWorkbenchWorkerIdentity} from '../services/runtime-box/workbench-worker-identity-repository.js';
import {upsertWorkbenchWorker} from '../services/execution/worker/worker-repository.js';
import {configureWorkbenchWorkerTransportCredential} from '../services/execution/worker/worker-transport-credentials.js';
import type {RemoteWorkbenchWorkerConfig} from '../services/execution/worker/worker-entrypoint.js';
export const PROVISIONING_WORKER_CAPABILITIES=Object.freeze(['file','job','service','shell']);
function required(env:NodeJS.ProcessEnv,name:string){const v=env[name]?.trim();if(!v)throw Error('provisioning_worker_input_invalid');return v;}
/** Explicit paths are host configuration, never customer request fields. */
export async function provisioningWorkerBootstrap(env:NodeJS.ProcessEnv=process.env){
 const workerId=required(env,'TOWER_BOOTSTRAP_WORKER_ID'),projectId=required(env,'TOWER_BOOTSTRAP_PROJECT_ID');
 const root=required(env,'TOWER_BOOTSTRAP_PROJECT_ROOT'),skills=required(env,'TOWER_PROVISIONING_MANAGED_SKILLS_ROOT'),bwrap=required(env,'TOWER_WORKER_BWRAP_BIN'),stage=required(env,'TOWER_BOOTSTRAP_STAGE_DIR');
 const actor=Number(required(env,'TOWER_BOOTSTRAP_ACTOR_USER_ID')),port=Number(required(env,'TOWER_BOOTSTRAP_WORKER_PORT')),rev=required(env,'TOWER_SOURCE_REV'),storePath=required(env,'TOWER_APP_ROOT');
 if(!/^[A-Za-z0-9_-]{1,120}$/.test(workerId)||!/^[a-f0-9-]{36}$/.test(projectId)||!Number.isSafeInteger(actor)||actor<1||!Number.isInteger(port)||port<1024||port>65535||!/^[a-f0-9]{40}$/.test(rev))throw Error('provisioning_worker_input_invalid');
 for(const dir of [root,skills,stage]){const s=await fs.lstat(dir);if(!path.isAbsolute(dir)||await fs.realpath(dir)!==dir||!s.isDirectory()||s.isSymbolicLink())throw Error('provisioning_worker_path_invalid');}
 const st=await fs.stat(stage);if(st.uid!==process.getuid?.()||(st.mode&0o077)!==0||(await fs.readdir(stage)).length!==0)throw Error('provisioning_worker_stage_invalid');
 if(!path.isAbsolute(bwrap)||/[\r\n]/.test(bwrap)||!path.isAbsolute(storePath))throw Error('provisioning_worker_path_invalid');await fs.access(bwrap,constants.X_OK);
 const project=await query<{root_path:string;role:string;disabled:number;member:boolean}>(`SELECT p.root_path,u.role,u.disabled,EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=u.id) AS member FROM projects p JOIN users u ON u.id=$2 WHERE p.id=$1 AND COALESCE(p.archived,0)=0`,[projectId,actor]);
 if(project.length!==1||project[0].root_path!==root||project[0].role!=='admin'||project[0].disabled!==0||!project[0].member)throw Error('provisioning_worker_actor_denied');
 const existing=await query(`SELECT worker_id FROM runtime_box_workbench_workers WHERE worker_id=$1 UNION SELECT worker_id FROM runtime_box_workbench_worker_identities WHERE worker_id=$1`,[workerId]);if(existing.length)throw Error('provisioning_worker_existing_identity_reconcile');
 const identity=issueWorkbenchWorkerIdentity({workerId,projectIds:[projectId],capabilities:[...PROVISIONING_WORKER_CAPABILITIES],expiresIn:'7d'});
 await recordWorkbenchWorkerIdentity({identity:identity.identity,issuedByUserId:actor,reason:'provisioning first Worker bootstrap'});
 await upsertWorkbenchWorker({workerId,deploymentId:'production',baseUrl:`http://127.0.0.1:${port}`,capabilities:[...PROVISIONING_WORKER_CAPABILITIES],projectIds:[projectId],capacity:{cpuTotal:2,memoryMbTotal:4096,activeRuns:0,maxRuns:3}});
 const token=crypto.randomBytes(48).toString('base64url');await configureWorkbenchWorkerTransportCredential({workerId,token,actorUserId:actor});
 const config={workerId,host:'127.0.0.1',port,projects:{[projectId]:root},managedSkillsRoot:skills,bwrapBin:bwrap,isolationProfile:'legacy-skill-dependent',runtimeProvenance:{sourceRev:rev,storePath}} satisfies RemoteWorkbenchWorkerConfig;
 for(const [suffix,content] of [['json',JSON.stringify(config)+'\n'],['env','TOWER_REMOTE_WORKER_TOKEN='+token+'\n'],['identity.jwt',identity.token+'\n']]){const f=await fs.open(path.join(stage,workerId+'.'+suffix),'wx',0o600);try{await f.writeFile(content);await f.sync();}finally{await f.close();}}
 const dir=await fs.open(stage,'r');try{await dir.sync();}finally{await dir.close();}
 return {status:'staged',workerId,capabilities:[...PROVISIONING_WORKER_CAPABILITIES],expiresAt:identity.identity.expiresAt};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 provisioningWorkerBootstrap().then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error('provisioning Worker bootstrap rejected; preserve intent and reconcile');process.exitCode=1;}).finally(closePgPool);
}
