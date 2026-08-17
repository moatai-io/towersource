/** Owns host-local operational checks for known External Worker v1 profiles. */
import { execFileSync } from 'node:child_process';
import type { WorkerDoctorCheck } from './workbench-worker-doctor.js';
/** Diagnose host components that are not represented in the Worker DB registry. */
export function diagnoseLocalWorkerComponents(workerId:string,isUnitActive=(unit:string)=>{try{execFileSync('systemctl',['--user','is-active','--quiet',unit],{stdio:'ignore'});return true}catch{return false}}):WorkerDoctorCheck[]{
 if(workerId!=='iwinv-01')return[];const unit='tower-iwinv-worker-tunnel.service';const active=isUnitActive(unit);return[{name:'tunnel',ok:active,detail:active?`${unit} is active`:`${unit} is inactive`,fix:active?undefined:'./start.sh worker-repair iwinv-01 --tunnel'}];
}
