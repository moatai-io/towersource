import fs from 'node:fs';import path from 'node:path';
import {readInterview} from './agent-interview.js';
export async function runAutomaticInterview(root:string,sessionId:string,userId:number, deps?:{hasHuman:()=>Promise<boolean>;run:()=>Promise<void>}):Promise<void>{
 const state=readInterview(root);if(!state||state.status!=='awaiting')return;
 const p=path.join(root,'.tower-interview-execution.json');
 try{fs.writeFileSync(p,JSON.stringify({status:'scheduled',questionId:state.questionId}),{flag:'wx'});}catch{return;}
 const save=(status:string)=>fs.writeFileSync(p,JSON.stringify({status,questionId:state.questionId}));
 try{
 const hasHuman=deps?.hasHuman??(async()=>{const {queryOne}=await import('../../db/pg-repo.js');const r=await queryOne<{n:string}>('SELECT count(*)::text n FROM messages WHERE session_id=$1 AND role=\'user\'',[sessionId]);return Number(r?.n)>0;});
 if(await hasHuman()){save('skipped-user-started');return;}
 save('running');
 if(deps)await deps.run();else{const {startInitialInterview}=await import('../../routes/ws-handler.js');await startInitialInterview(sessionId,userId);}
 save('completed');
 }catch{save('failed');}
}
export function scheduleAutomaticInterview(root:string,sessionId:string,userId:number):void{setTimeout(()=>{void runAutomaticInterview(root,sessionId,userId);},500);}

export function readAutomaticInterview(root:string):string|null{try{const p=path.join(root,'.tower-interview-execution.json');const stat=fs.lstatSync(p);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)return null;return JSON.parse(fs.readFileSync(p,'utf8')).status;}catch{return null;}}

export async function dispatchDurableInterviews():Promise<void>{
 const {query}=await import('../../db/pg-repo.js');
 const {claimDurableInterview}=await import('./durable-interview.js');
 const {execute:expire}=await import('../../db/pg-repo.js');
 await expire("UPDATE agent_initial_interviews SET status='failed' WHERE status='running' AND lease_until<now()");
 const rows=await query<any>("SELECT project_id FROM agent_initial_interviews WHERE status='scheduled' LIMIT 10");
 for(const r of rows){const claim=await claimDurableInterview(r.project_id);if(!claim)continue;
 try{const {startInitialInterview}=await import('../../routes/ws-handler.js');await startInitialInterview(claim.session_id,claim.actor_user_id,claim.token);
 }catch{/* Terminal outcome set below without exposing provider errors. */}
 const {execute}=await import('../../db/pg-repo.js');await execute("UPDATE agent_initial_interviews SET status='failed',updated_at=now() WHERE project_id=$1 AND token=$2 AND status='running'",[r.project_id,claim.token]);
 }
}
